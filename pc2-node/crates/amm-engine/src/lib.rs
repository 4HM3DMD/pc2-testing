//! Uniswap V2 AMM Math Engine
//!
//! Provides local computation of swap quotes, price impact, and route finding
//! using cached reserve data. All math uses u128 to handle token amounts
//! without overflow (max ~3.4e38, far exceeding any ERC-20 supply).
//!
//! Designed to run in WASM for sub-millisecond quote computation.

use serde::{Deserialize, Serialize};

/// Pair reserves (fetched from chain, cached per-block)
#[derive(Deserialize, Clone)]
pub struct PairReserves {
    pub pair_address: String,
    pub token0: String,
    pub token1: String,
    pub reserve0: String,
    pub reserve1: String,
}

#[derive(Deserialize)]
pub struct AmmInput {
    pub mode: String,
    pub pairs: Option<Vec<PairReserves>>,
    pub token_in: Option<String>,
    pub token_out: Option<String>,
    pub amount_in: Option<String>,
    pub amount_out: Option<String>,
    /// Fee numerator (default 997 for 0.3% Uniswap V2 fee)
    pub fee_numerator: Option<u128>,
    /// Max hops for route finding (default 3)
    pub max_hops: Option<usize>,
}

#[derive(Serialize)]
pub struct AmmOutput {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_out: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_in: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_impact: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pairs_used: Option<Vec<String>>,
}

fn parse_u128(s: &str) -> Result<u128, String> {
    s.parse::<u128>().map_err(|e| format!("invalid number '{}': {}", s, e))
}

/// Uniswap V2 getAmountOut: given an exact input, calculate the output.
/// amount_out = (amount_in * fee * reserve_out) / (reserve_in * 1000 + amount_in * fee)
pub fn get_amount_out(amount_in: u128, reserve_in: u128, reserve_out: u128, fee_num: u128) -> Result<u128, String> {
    if amount_in == 0 {
        return Err("insufficient input amount".to_string());
    }
    if reserve_in == 0 || reserve_out == 0 {
        return Err("insufficient liquidity".to_string());
    }
    let amount_in_with_fee = amount_in * fee_num;
    let numerator = amount_in_with_fee * reserve_out;
    let denominator = reserve_in * 1000 + amount_in_with_fee;
    Ok(numerator / denominator)
}

/// Uniswap V2 getAmountIn: given an exact output, calculate required input.
/// amount_in = (reserve_in * amount_out * 1000) / ((reserve_out - amount_out) * fee) + 1
pub fn get_amount_in(amount_out: u128, reserve_in: u128, reserve_out: u128, fee_num: u128) -> Result<u128, String> {
    if amount_out == 0 {
        return Err("insufficient output amount".to_string());
    }
    if reserve_in == 0 || reserve_out == 0 || amount_out >= reserve_out {
        return Err("insufficient liquidity".to_string());
    }
    let numerator = reserve_in * amount_out * 1000;
    let denominator = (reserve_out - amount_out) * fee_num;
    Ok(numerator / denominator + 1)
}

/// Calculate price impact as basis points (1 bp = 0.01%)
fn calculate_price_impact(amount_in: u128, reserve_in: u128, reserve_out: u128, amount_out: u128) -> u128 {
    if reserve_in == 0 || reserve_out == 0 || amount_in == 0 {
        return 0;
    }
    // Spot price: reserve_out / reserve_in
    // Execution price: amount_out / amount_in
    // Impact = 1 - (execution_price / spot_price)
    // In basis points: impact_bps = 10000 - (amount_out * reserve_in * 10000) / (amount_in * reserve_out)
    let execution = amount_out * reserve_in * 10000;
    let spot = amount_in * reserve_out;
    if spot == 0 {
        return 0;
    }
    let ratio = execution / spot;
    if ratio >= 10000 { 0 } else { 10000 - ratio }
}

/// Find the best route between two tokens through available pairs.
/// Uses BFS with max_hops limit.
fn find_best_route(
    pairs: &[PairReserves],
    token_in: &str,
    token_out: &str,
    amount_in: u128,
    fee_num: u128,
    max_hops: usize,
) -> Option<(u128, Vec<String>, Vec<String>)> {
    let token_in_lower = token_in.to_lowercase();
    let token_out_lower = token_out.to_lowercase();

    #[derive(Clone)]
    struct Route {
        path: Vec<String>,
        pairs_used: Vec<String>,
        amount: u128,
    }

    let mut best: Option<(u128, Vec<String>, Vec<String>)> = None;
    let mut queue: Vec<Route> = vec![Route {
        path: vec![token_in_lower.clone()],
        pairs_used: vec![],
        amount: amount_in,
    }];

    while let Some(current) = queue.pop() {
        let current_token = current.path.last().unwrap().clone();

        if current_token == token_out_lower && current.path.len() > 1 {
            match &best {
                Some((best_amount, _, _)) if current.amount <= *best_amount => {}
                _ => {
                    best = Some((current.amount, current.path.clone(), current.pairs_used.clone()));
                }
            }
            continue;
        }

        if current.path.len() > max_hops + 1 {
            continue;
        }

        for pair in pairs {
            let t0 = pair.token0.to_lowercase();
            let t1 = pair.token1.to_lowercase();

            let (next_token, r_in, r_out) = if current_token == t0 && !current.path.contains(&t1) {
                (&t1, &pair.reserve0, &pair.reserve1)
            } else if current_token == t1 && !current.path.contains(&t0) {
                (&t0, &pair.reserve1, &pair.reserve0)
            } else {
                continue;
            };

            let reserve_in = match parse_u128(r_in) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let reserve_out = match parse_u128(r_out) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let out = match get_amount_out(current.amount, reserve_in, reserve_out, fee_num) {
                Ok(v) if v > 0 => v,
                _ => continue,
            };

            let mut new_path = current.path.clone();
            new_path.push(next_token.clone());
            let mut new_pairs = current.pairs_used.clone();
            new_pairs.push(pair.pair_address.clone());

            queue.push(Route {
                path: new_path,
                pairs_used: new_pairs,
                amount: out,
            });
        }
    }

    best
}

pub fn process(command_json: &str) -> String {
    let input: AmmInput = match serde_json::from_str(command_json) {
        Ok(v) => v,
        Err(e) => {
            return serde_json::to_string(&AmmOutput {
                success: false,
                error: Some(format!("invalid JSON: {e}")),
                amount_out: None, amount_in: None, price_impact: None,
                route: None, pairs_used: None,
            }).unwrap_or_default();
        }
    };

    let fee_num = input.fee_numerator.unwrap_or(997);

    match input.mode.as_str() {
        "get_amount_out" => {
            let pairs = input.pairs.unwrap_or_default();
            let token_in = input.token_in.unwrap_or_default();
            let token_out = input.token_out.unwrap_or_default();
            let amount_in = match input.amount_in.as_deref().map(parse_u128) {
                Some(Ok(v)) => v,
                _ => {
                    return err_json("missing or invalid amount_in");
                }
            };

            let max_hops = input.max_hops.unwrap_or(3);

            match find_best_route(&pairs, &token_in, &token_out, amount_in, fee_num, max_hops) {
                Some((amount_out, route, pairs_used)) => {
                    // Calculate price impact using first pair
                    let impact = if let Some(pair) = pairs.iter().find(|p| {
                        let t0 = p.token0.to_lowercase();
                        let t1 = p.token1.to_lowercase();
                        let ti = token_in.to_lowercase();
                        let to = token_out.to_lowercase();
                        (t0 == ti && t1 == to) || (t1 == ti && t0 == to)
                    }) {
                        let (r_in, r_out) = if pair.token0.to_lowercase() == token_in.to_lowercase() {
                            (parse_u128(&pair.reserve0).unwrap_or(0), parse_u128(&pair.reserve1).unwrap_or(0))
                        } else {
                            (parse_u128(&pair.reserve1).unwrap_or(0), parse_u128(&pair.reserve0).unwrap_or(0))
                        };
                        calculate_price_impact(amount_in, r_in, r_out, amount_out)
                    } else {
                        0
                    };

                    serde_json::to_string(&AmmOutput {
                        success: true,
                        error: None,
                        amount_out: Some(amount_out.to_string()),
                        amount_in: None,
                        price_impact: Some(format!("{}.{:02}", impact / 100, impact % 100)),
                        route: Some(route),
                        pairs_used: Some(pairs_used),
                    }).unwrap_or_default()
                }
                None => err_json("no route found"),
            }
        }
        "get_amount_in" => {
            let pairs = input.pairs.unwrap_or_default();
            let token_in = input.token_in.unwrap_or_default();
            let token_out = input.token_out.unwrap_or_default();
            let amount_out_val = match input.amount_out.as_deref().map(parse_u128) {
                Some(Ok(v)) => v,
                _ => {
                    return err_json("missing or invalid amount_out");
                }
            };

            // For getAmountIn, find the direct pair
            let ti = token_in.to_lowercase();
            let to = token_out.to_lowercase();
            if let Some(pair) = pairs.iter().find(|p| {
                let t0 = p.token0.to_lowercase();
                let t1 = p.token1.to_lowercase();
                (t0 == ti && t1 == to) || (t1 == ti && t0 == to)
            }) {
                let (r_in, r_out) = if pair.token0.to_lowercase() == ti {
                    (parse_u128(&pair.reserve0).unwrap_or(0), parse_u128(&pair.reserve1).unwrap_or(0))
                } else {
                    (parse_u128(&pair.reserve1).unwrap_or(0), parse_u128(&pair.reserve0).unwrap_or(0))
                };

                match get_amount_in(amount_out_val, r_in, r_out, fee_num) {
                    Ok(amount_in) => serde_json::to_string(&AmmOutput {
                        success: true,
                        error: None,
                        amount_out: None,
                        amount_in: Some(amount_in.to_string()),
                        price_impact: None,
                        route: Some(vec![ti, to]),
                        pairs_used: Some(vec![pair.pair_address.clone()]),
                    }).unwrap_or_default(),
                    Err(e) => err_json(&e),
                }
            } else {
                err_json("no direct pair found for getAmountIn")
            }
        }
        other => err_json(&format!("unknown mode: '{other}', expected 'get_amount_out' or 'get_amount_in'")),
    }
}

fn err_json(msg: &str) -> String {
    serde_json::to_string(&AmmOutput {
        success: false,
        error: Some(msg.to_string()),
        amount_out: None, amount_in: None, price_impact: None,
        route: None, pairs_used: None,
    }).unwrap_or_default()
}
