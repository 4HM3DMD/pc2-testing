/**
 * Elacity Market — Extended Features Module
 * Implements: Earnings badge, Activity history, Publish/Unpublish,
 * Scarcity indicators, Expanded earnings, Offers, Channel management,
 * Token-gating, Subscription lifecycle, Distribution rights.
 *
 * Depends on window.ElaMarket namespace from app.js
 */
(function () {
  'use strict';

  var M = window.ElaMarket;
  var state = M.state;
  var dom = M.dom;
  var u = M.utils;

  // ── Earnings Notification Badge (per-tab counts) ──

  state._earningsCounts = { assets: 0, channels: 0, offersMade: 0, offersReceived: 0 };

  function updateEarningsBadge() {
    if (!Wallet.isConnected()) return;

    var eoaAddr = Wallet.getAddress();
    var saAddr = Wallet.getSmartAccountAddress();
    var hasSA = Wallet.hasSmartAccount() && saAddr && saAddr.toLowerCase() !== eoaAddr.toLowerCase();

    var fetches = [
      ElacityAPI.fetchRewardSummary(eoaAddr, 'assets').catch(function () { return []; }),
      ElacityAPI.fetchRewardSummary(eoaAddr, 'channels').catch(function () { return []; }),
      ElacityAPI.searchOfferEvents(null, null, 50).catch(function () { return []; }),
      ElacityAPI.searchIncomingOfferEvents(null, null, 50).catch(function () { return []; }),
      ElacityAPI.getV3Operatives()
    ];
    if (hasSA) {
      fetches.push(ElacityAPI.fetchRewardSummary(saAddr, 'assets').catch(function () { return []; }));
      fetches.push(ElacityAPI.fetchRewardSummary(saAddr, 'channels').catch(function () { return []; }));
    }

    Promise.all(fetches).then(function (results) {
      var assetRewards = results[0] || [];
      var channelRewards = results[1] || [];
      var v3Set = results[4] || new Set();
      var outOffers = (results[2] || []).filter(function (evt) {
        var addr = getOfferContractAddr(evt);
        return addr && v3Set.has(addr.toLowerCase());
      });
      var inOffers = (results[3] || []).filter(function (evt) {
        var addr = getOfferContractAddr(evt);
        return addr && v3Set.has(addr.toLowerCase());
      });

      if (hasSA) {
        assetRewards = assetRewards.concat(results[5] || []);
        channelRewards = channelRewards.concat(results[6] || []);
      }

      var assetCount = 0; var seenA = {};
      assetRewards.forEach(function (r) { if (!seenA[r.name] && r.unclaimedRewards > 0) { seenA[r.name] = true; assetCount++; } });

      var channelCount = 0; var seenC = {};
      channelRewards.forEach(function (r) { if (!seenC[r.name] && r.unclaimedRewards > 0) { seenC[r.name] = true; channelCount++; } });

      state._earningsCounts = {
        assets: Math.min(assetCount, 99),
        channels: Math.min(channelCount, 99),
        offersMade: Math.min(outOffers.length, 99),
        offersReceived: Math.min(inOffers.length, 99)
      };

      var totalCount = assetCount + channelCount + outOffers.length + inOffers.length;

      var badge = document.getElementById('earnings-badge');
      if (badge) {
        if (totalCount > 0) {
          badge.textContent = totalCount > 99 ? '99+' : totalCount;
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
        }
      }

      updateTabBadges();
    }).catch(function () {});
  }

  function updateTabBadges() {
    var counts = state._earningsCounts;
    var tabsEl = document.getElementById('earnings-tabs');
    if (!tabsEl) return;

    tabsEl.querySelectorAll('.earnings-tab').forEach(function (tab) {
      var key = tab.dataset.tab;
      var count = 0;
      if (key === 'assets') count = counts.assets;
      else if (key === 'channels') count = counts.channels;
      else if (key === 'offers') count = (counts.offersMade + counts.offersReceived);

      var badge = tab.querySelector('.tab-badge');
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'tab-badge';
          badge.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;font-size:10px;font-weight:700;line-height:16px;color:#fff;background:#ef4444;border-radius:8px;margin-left:6px;';
          tab.appendChild(badge);
        }
        badge.textContent = count > 99 ? '99+' : count;
      } else if (badge) {
        badge.remove();
      }
    });
  }

  // ── Activity History ──────────────────────────────

  function renderActivitySection(nft) {
    var operative = nft.operative || {};
    var operativeAddr = operative.address || '';
    if (!operativeAddr) return;

    var container = document.getElementById('detail-activity');
    if (!container) {
      container = document.createElement('div');
      container.id = 'detail-activity';
      container.className = 'activity-section';
      var anchor = document.getElementById('detail-activity-anchor');
      if (anchor) {
        anchor.parentNode.insertBefore(container, anchor);
      } else {
        var body = document.querySelector('.detail-body');
        if (body) body.appendChild(container);
      }
    }

    var tokenId = (nft.tokenId && nft.tokenId.hexTokenID) || nft.tokenId || '0';

    container.innerHTML =
      '<div class="activity-accordion" id="activity-accordion">' +
        '<button class="activity-accordion-toggle" onclick="this.parentNode.classList.toggle(\'open\')">' +
          '<span>Activity</span>' +
          '<span class="accordion-arrow">&#9662;</span>' +
        '</button>' +
        '<div class="activity-accordion-body">' +
          '<div class="activity-tabs">' +
            '<button class="activity-tab active" data-atype="listings">Listings</button>' +
            '<button class="activity-tab" data-atype="sales">Sales</button>' +
            '<button class="activity-tab" data-atype="offers">Offers</button>' +
          '</div>' +
          '<div class="activity-events" id="activity-events"><div class="loading-indicator"><div class="spinner"></div></div></div>' +
        '</div>' +
      '</div>';

    container.querySelectorAll('.activity-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        container.querySelectorAll('.activity-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        loadActivityTab(operativeAddr, tokenId, tab.dataset.atype);
      });
    });

    loadActivityTab(operativeAddr, tokenId, 'listings');
  }

  function loadActivityTab(contractAddress, tokenId, type) {
    var eventsEl = document.getElementById('activity-events');
    if (!eventsEl) return;
    eventsEl.innerHTML = '<div class="loading-indicator"><div class="spinner"></div></div>';

    var fn;
    if (type === 'listings') fn = ElacityAPI.searchListingEvents;
    else if (type === 'sales') fn = ElacityAPI.searchTradeEvents;
    else fn = ElacityAPI.searchOfferEvents;

    fn(contractAddress, tokenId, 20).then(function (events) {
      if (!events || events.length === 0) {
        eventsEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-tertiary);font-size:12px;">No events found</div>';
        return;
      }

      var html = '';
      events.forEach(function (evt) {
        var iconClass = type === 'listings' ? 'listing' : type === 'sales' ? 'sale' : 'offer';
        var iconSymbol = type === 'listings' ? '&#9998;' : type === 'sales' ? '&#10003;' : '&#9733;';
        var fromAddr = (evt.from && evt.from.address) ? u.formatAddress(evt.from.address) : '—';
        var toAddr = (evt.to && evt.to.address) ? u.formatAddress(evt.to.address) : '—';
        var price = evt.price ? u.formatPrice(evt.price, evt.paymentToken) : '';
        var date = evt.createdAt ? new Date(evt.createdAt).toLocaleDateString() : '';
        var txLink = evt.txHash ? '<a href="https://basescan.org/tx/' + evt.txHash + '" target="_blank" rel="noopener">View tx</a>' : '';

        html += '<div class="activity-event">';
        html += '<div class="event-icon ' + iconClass + '">' + iconSymbol + '</div>';
        html += '<div class="event-details">';
        html += '<div class="event-action">' + u.escapeHtml(evt.event || type) + (evt.quantity ? ' x' + evt.quantity : '') + '</div>';
        html += '<div class="event-addrs">' + fromAddr + ' → ' + toAddr + '</div>';
        html += '</div>';
        html += '<div class="event-right">';
        if (price) html += '<div class="event-price">' + price + '</div>';
        html += '<div class="event-date">' + date + '</div>';
        if (txLink) html += '<div class="event-tx">' + txLink + '</div>';
        html += '</div>';
        html += '</div>';
      });
      eventsEl.innerHTML = html;
    }).catch(function (err) {
      eventsEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-tertiary);font-size:12px;">Failed to load: ' + u.escapeHtml(err.message) + '</div>';
    });
  }

  // ── Publish/Unpublish Toggle ──────────────────────

  function renderPublishToggle(nft) {
    var operative = nft.operative || {};
    var operativeAddr = operative.address || '';
    if (!operativeAddr || !Wallet.isConnected()) return;

    var publisherAddr = (nft.metadata && nft.metadata.properties && nft.metadata.properties.publisher && nft.metadata.properties.publisher.address) || '';
    var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
    var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();
    var isPublisher = publisherAddr && (publisherAddr.toLowerCase() === eoaAddr || publisherAddr.toLowerCase() === saAddr);

    if (!isPublisher) return;

    var tokenId = (nft.tokenId && nft.tokenId.hexTokenID) || nft.tokenId || '0';
    var ledger = nft.ledger || nft.address || '';

    ElacityAPI.fetchStatisticByAsset(operativeAddr, ledger, tokenId).then(function (stat) {
      if (!stat) return;

      var isUnpublished = !!stat.unpublished;
      var container = document.getElementById('detail-publish-toggle');
      if (!container) {
        container = document.createElement('div');
        container.id = 'detail-publish-toggle';
        var ownerActions = document.getElementById('detail-owner-actions');
        if (ownerActions) ownerActions.parentNode.insertBefore(container, ownerActions.nextSibling);
      }

      container.innerHTML =
        '<div class="publish-toggle-wrap">' +
          '<span class="publish-toggle-label">' + (isUnpublished ? 'Asset is unpublished' : 'Asset is published') + '</span>' +
          '<button class="toggle-switch' + (isUnpublished ? '' : ' active') + '" id="publish-toggle-btn"></button>' +
        '</div>';

      var btn = document.getElementById('publish-toggle-btn');
      btn.addEventListener('click', function () {
        var newUnpub = !isUnpublished;
        btn.disabled = true;
        ElacityAPI.toggleUnpublish(operativeAddr, tokenId, newUnpub).then(function () {
          isUnpublished = newUnpub;
          btn.classList.toggle('active', !newUnpub);
          container.querySelector('.publish-toggle-label').textContent = newUnpub ? 'Asset is unpublished' : 'Asset is published';
          btn.disabled = false;
          u.showToast(newUnpub ? 'Asset unpublished' : 'Asset published', 'success');
        }).catch(function (err) {
          btn.disabled = false;
          u.showToast('Failed: ' + err.message, 'error');
        });
      });
    }).catch(function () {});
  }

  // ── Scarcity badges are built into renderCard() in app.js ──
  // ── Urgency indicator is built into renderSupplyInfo() in app.js ──

  // ── Expanded Earnings ─────────────────────────────

  function enhanceEarningsItems() {
    var listEl = document.getElementById('earnings-list');
    if (!listEl) return;

    listEl.querySelectorAll('.earnings-item').forEach(function (item) {
      if (item.dataset.enhanced) return;
      item.dataset.enhanced = '1';
      item.classList.add('expandable');

      var contractAddr = item.dataset.contract;
      var ledger = item.dataset.ledger || '';
      var tokenId = item.dataset.hextokenid || '';

      var expandIcon = document.createElement('span');
      expandIcon.className = 'earnings-item-expand-icon';
      expandIcon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
      item.appendChild(expandIcon);

      var panel = document.createElement('div');
      panel.className = 'earnings-expanded-panel';
      panel.innerHTML = '<div class="loading-indicator"><div class="spinner"></div><span>Loading stats...</span></div>';
      item.appendChild(panel);

      var itemType = item.dataset.itemtype || 'asset';

      item.addEventListener('click', function (e) {
        if (e.target.closest('.earnings-withdraw-btn') || e.target.closest('.action-btn')) return;
        item.classList.toggle('expanded');
        if (item.classList.contains('expanded') && !panel.dataset.loaded) {
          loadExpandedStats(panel, contractAddr, ledger, tokenId, itemType);
        }
      });
    });
  }

  function loadExpandedStats(panel, contractAddr, ledger, tokenId, itemType) {
    var eoaAddr = Wallet.getAddress() || '';
    var saAddr = Wallet.getSmartAccountAddress() || '';
    var account = Wallet.getSignerAddress() || eoaAddr;
    var isChannel = (itemType === 'channel');

    var fetches = [];
    if (!isChannel && ledger && tokenId) {
      fetches.push(ElacityAPI.fetchStatisticByAsset(contractAddr, ledger, tokenId).catch(function () { return null; }));
    } else {
      fetches.push(Promise.resolve(null));
    }
    fetches.push(ElacityAPI.governanceStatistics(contractAddr, account).catch(function () { return null; }));

    if (contractAddr) {
      fetches.push(Wallet.getPendingRewards(contractAddr, account, Wallet.USDC_ADDRESS).catch(function () { return '0'; }));
      fetches.push(Wallet.getPendingRewards(contractAddr, account, '0x0000000000000000000000000000000000000000').catch(function () { return '0'; }));
    } else {
      fetches.push(Promise.resolve('0'), Promise.resolve('0'));
    }

    if (isChannel) {
      fetches.push(ElacityAPI.listSubscribers(contractAddr).catch(function () { return { count: 0 }; }));
      fetches.push(ElacityAPI.retrieveChannel(contractAddr).catch(function () { return null; }));
    } else {
      fetches.push(Promise.resolve(null), Promise.resolve(null));
    }

    // [6] on-chain royalty balance for current user (EOA + SA combined)
    if (!isChannel && contractAddr) {
      fetches.push(
        Promise.all([
          Wallet.getRoyaltyShareBalance(contractAddr, eoaAddr).catch(function () { return 0; }),
          saAddr ? Wallet.getRoyaltyShareBalance(contractAddr, saAddr).catch(function () { return 0; }) : Promise.resolve(0)
        ]).then(function (bals) { return Number(bals[0]) + Number(bals[1]); })
      );
    } else {
      fetches.push(Promise.resolve(0));
    }

    Promise.all(fetches).then(function (results) {
      var stat = results[0];
      var gov = results[1];
      var usdcRewards = results[2] || '0';
      var ethRewards = results[3] || '0';
      var subInfo = results[4];
      var channelInfo = results[5];
      var onChainRoyaltyBal = results[6] || 0;
      panel.dataset.loaded = '1';

      var html = '<div class="stats-cards">';

      if (isChannel && channelInfo) {
        var subCount = (subInfo && subInfo.count) || 0;
        var plans = channelInfo.plans || [];
        var cheapest = plans.length > 0 ? plans.reduce(function (a, b) { return (a.price || Infinity) < (b.price || Infinity) ? a : b; }) : null;
        var chType = channelInfo.isPublic ? 'Public' : 'Private';

        html += '<div class="stat-card"><div class="stat-card-label">Subscribers</div><div class="stat-card-value">' + subCount + '</div></div>';
        html += '<div class="stat-card"><div class="stat-card-label">Channel Type</div><div class="stat-card-value">' + chType + '</div></div>';
        html += '<div class="stat-card"><div class="stat-card-label">Assets</div><div class="stat-card-value">' + (channelInfo.itemsCount || 0) + '</div></div>';
        if (cheapest) {
          html += '<div class="stat-card"><div class="stat-card-label">Entry Price</div><div class="stat-card-value">' + u.formatPrice(cheapest.price, cheapest.payToken) + '</div></div>';
        }
      }

      if (stat) {
        html += '<div class="stat-card"><div class="stat-card-label">Views</div><div class="stat-card-value">' + (stat.views || 0).toLocaleString() + '</div></div>';
        html += '<div class="stat-card"><div class="stat-card-label">Sold / Supply</div><div class="stat-card-value">' + (stat.sold || 0) + ' / ' + (stat.totalSupply || 0) + '</div></div>';
        if (stat.price) {
          html += '<div class="stat-card"><div class="stat-card-label">Sale Price</div><div class="stat-card-value">' + u.formatPrice(stat.price) + '</div></div>';
        }
        html += '<div class="stat-card"><div class="stat-card-label">Revenue</div><div class="stat-card-value">$' + ((stat.totalRevenue || 0) / 1e6).toFixed(2) + '</div></div>';
        if (stat.resell) {
          html += '<div class="stat-card"><div class="stat-card-label">Resales</div><div class="stat-card-value">' + (stat.resell.totalResell || 0) + '</div></div>';
          html += '<div class="stat-card"><div class="stat-card-label">Vendors</div><div class="stat-card-value">' + (stat.resell.totalVendors || 0) + '</div></div>';
        }
      }

      var govOwned = (gov && gov.governance && gov.governance.owned) || 0;
      var govAvail = (gov && gov.governance && gov.governance.available) || 0;
      var govVol = (gov && gov.governance && gov.governance.volumeUSD) || 0;

      // V3 on-chain fallback: 1000 royalty tokens = 100%
      if (govOwned === 0 && onChainRoyaltyBal > 0) {
        govOwned = onChainRoyaltyBal;
        govAvail = 1000;
      }

      if (govOwned > 0 || govAvail > 0) {
        var yourPct = (govOwned / 10).toFixed(1);
        var availPct = govAvail > 0 ? ((govAvail / 10).toFixed(1)) : '0';
        html += '<div class="stat-card"><div class="stat-card-label">Your Royalty</div><div class="stat-card-value">' + yourPct + '%</div></div>';
        html += '<div class="stat-card"><div class="stat-card-label">Total Supply</div><div class="stat-card-value">' + availPct + '%</div></div>';
        if (govVol > 0) {
          html += '<div class="stat-card"><div class="stat-card-label">Gov. Volume</div><div class="stat-card-value">$' + govVol.toFixed(2) + '</div></div>';
        }
      }

      if (gov && gov.floor !== undefined && gov.floor !== null) {
        var floorVal = (typeof gov.floor === 'object') ? gov.floor.price : gov.floor;
        if (floorVal) html += '<div class="stat-card"><div class="stat-card-label">Floor (Royalty)</div><div class="stat-card-value">' + u.formatPrice(floorVal) + '</div></div>';
      }

      html += '</div>';

      var usdcVal = parseFloat(usdcRewards) / 1e6;
      var ethVal = parseFloat(ethRewards) / 1e18;
      var hasUsdc = usdcVal > 0.001;
      var hasEth = ethVal > 0.00001;

      if (hasUsdc || hasEth) {
        html += '<div class="withdraw-section" style="margin-top:10px;padding:10px 12px;background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.2);border-radius:8px;">';
        html += '<div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">Claimable Rewards</div>';
        if (hasUsdc) {
          html += '<div class="withdraw-token-row" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">';
          html += '<span style="font-size:12px;">USDC: <strong>$' + usdcVal.toFixed(2) + '</strong></span>';
          html += '<button class="earnings-withdraw-btn" data-action="withdraw" data-contract="' + u.escapeHtml(contractAddr) + '" data-paytoken="' + Wallet.USDC_ADDRESS + '" data-wallet="' + walletKey + '">Withdraw</button>';
          html += '</div>';
        }
        if (hasEth) {
          html += '<div class="withdraw-token-row" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">';
          html += '<span style="font-size:12px;">ETH: <strong>' + ethVal.toFixed(6) + '</strong></span>';
          html += '<button class="earnings-withdraw-btn" data-action="withdraw" data-contract="' + u.escapeHtml(contractAddr) + '" data-paytoken="0x0000000000000000000000000000000000000000" data-wallet="' + walletKey + '">Withdraw</button>';
          html += '</div>';
        }
        if (hasUsdc && hasEth) {
          html += '<button class="earnings-withdraw-btn" data-action="withdraw-all" data-contract="' + u.escapeHtml(contractAddr) + '" data-wallet="' + walletKey + '" style="margin-top:4px;background:var(--accent);">Withdraw All</button>';
        }
        html += '</div>';
      }

      if (gov && gov.royalties && gov.royalties.distribution) {
        var distData;
        try { distData = typeof gov.royalties.distribution === 'string' ? JSON.parse(gov.royalties.distribution) : gov.royalties.distribution; } catch (e) { distData = null; }

        if (distData && typeof distData === 'object') {
          html += '<div class="distribution-bars">';
          html += '<div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">Royalty Distribution</div>';
          var colors = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6'];
          var entries = Object.entries(distData);
          var ci = 0;
          entries.forEach(function (entry) {
            var label = entry[0];
            var pct = parseFloat(entry[1]) || 0;
            var color = colors[ci % colors.length];
            ci++;
            html += '<div class="distribution-bar-row">';
            html += '<span class="distribution-bar-label">' + u.formatAddress(label) + '</span>';
            html += '<div class="distribution-bar-track"><div class="distribution-bar-fill" style="width:' + Math.min(pct, 100) + '%;background:' + color + '"></div></div>';
            html += '<span class="distribution-bar-pct">' + pct.toFixed(1) + '%</span>';
            html += '</div>';
          });
          html += '</div>';
        }
      }

      var walletLabel = panel.closest('.earnings-item') ? (panel.closest('.earnings-item').dataset.walletlabel || '') : '';
      var walletKey = walletLabel.toLowerCase().indexOf('smart') !== -1 ? 'sa' : 'eoa';
      var ownerAddr = walletKey === 'sa' ? (Wallet.getSmartAccountAddress() || eoaAddr) : eoaAddr;

      // Action buttons moved to top-level earnings-item-actions row

      panel.innerHTML = html;

      panel.querySelectorAll('[data-action="withdraw"]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var contract = btn.dataset.contract;
          var paytoken = btn.dataset.paytoken;
          var wKey = btn.dataset.wallet || walletKey;
          btn.disabled = true;
          btn.textContent = '...';
          Wallet.withdrawRewards(contract, paytoken, wKey).then(function () {
            u.showToast('Withdrawal submitted!', 'success');
            btn.textContent = 'Done';
            if (typeof ElacityAPI !== 'undefined' && ElacityAPI.clearEarningsCache) ElacityAPI.clearEarningsCache(true);
            var M = window.ElaMarket || {};
            if (M.loadEarningsData && M.state) setTimeout(function () { M.loadEarningsData(M.state.earningsTab); }, 3000);
          }).catch(function (err) {
            btn.disabled = false;
            btn.textContent = 'Withdraw';
            if (err.message && err.message.indexOf('rejected') === -1) {
              u.showToast('Failed: ' + u.decodeContractError(err.message), 'error');
            }
          });
        });
      });

      panel.querySelectorAll('[data-action="withdraw-all"]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var contract = btn.dataset.contract;
          var wKey = btn.dataset.wallet || walletKey;
          btn.disabled = true;
          btn.textContent = '...';
          var tokens = [Wallet.USDC_ADDRESS, '0x0000000000000000000000000000000000000000'];
          Wallet.batchWithdrawRewards(contract, tokens, wKey).then(function () {
            u.showToast('All rewards withdrawn!', 'success');
            btn.textContent = 'Done';
            if (typeof ElacityAPI !== 'undefined' && ElacityAPI.clearEarningsCache) ElacityAPI.clearEarningsCache(true);
            var M = window.ElaMarket || {};
            if (M.loadEarningsData && M.state) setTimeout(function () { M.loadEarningsData(M.state.earningsTab); }, 3000);
          }).catch(function (err) {
            btn.disabled = false;
            btn.textContent = 'Withdraw All';
            if (err.message && err.message.indexOf('rejected') === -1) {
              u.showToast('Failed: ' + u.decodeContractError(err.message), 'error');
            }
          });
        });
      });

      // Action buttons (List Shares/Transfer/Sell) moved to top-level row
    });
  }

  // ── List Royalty Shares Modal ────────────────────

  function openListSharesModal(contractAddr, walletKey, currentBalance) {
    var existing = document.getElementById('list-shares-modal');
    if (existing) existing.remove();

    var pctLabel = (currentBalance / 10).toFixed(1);

    var modal = document.createElement('div');
    modal.id = 'list-shares-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML =
      '<div class="modal-dialog">' +
        '<div class="modal-header">' +
          '<h3>List Royalty Shares for Sale</h3>' +
          '<button class="modal-close-btn" id="list-shares-close">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<p class="modal-desc">You hold <strong>' + currentBalance + '</strong> royalty tokens (' + pctLabel + '%) from wallet: <strong>' + (walletKey === 'sa' ? 'Smart Account' : 'EOA') + '</strong></p>' +
          '<div class="form-group">' +
            '<label for="ls-quantity">Quantity to list (10 tokens = 1%)</label>' +
            '<input type="number" id="ls-quantity" min="1" max="' + currentBalance + '" step="1" placeholder="e.g. 10" class="form-input" />' +
          '</div>' +
          '<div class="form-group">' +
            '<label for="ls-price">Price per token (USDC)</label>' +
            '<input type="number" id="ls-price" min="0.000001" step="0.01" placeholder="e.g. 5.00" class="form-input" />' +
          '</div>' +
          '<div id="ls-summary" style="font-size:12px;color:var(--text-secondary);padding:6px 0;"></div>' +
          '<div id="ls-status" class="modal-status hidden"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button id="ls-cancel" class="btn-secondary">Cancel</button>' +
          '<button id="ls-confirm" class="btn-primary">List for Sale</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    var qtyInput = document.getElementById('ls-quantity');
    var priceInput = document.getElementById('ls-price');
    var summaryEl = document.getElementById('ls-summary');

    function updateSummary() {
      var q = parseInt(qtyInput.value) || 0;
      var p = parseFloat(priceInput.value) || 0;
      if (q > 0 && p > 0) {
        summaryEl.textContent = 'Total: $' + (q * p).toFixed(2) + ' USDC for ' + (q / 10).toFixed(1) + '% royalty share';
      } else {
        summaryEl.textContent = '';
      }
    }
    qtyInput.addEventListener('input', updateSummary);
    priceInput.addEventListener('input', updateSummary);

    document.getElementById('list-shares-close').addEventListener('click', function () { modal.remove(); });
    document.getElementById('ls-cancel').addEventListener('click', function () { modal.remove(); });

    document.getElementById('ls-confirm').addEventListener('click', function () {
      var qty = parseInt(qtyInput.value);
      var priceUsd = parseFloat(priceInput.value);
      if (!qty || qty <= 0 || qty > currentBalance) { u.showToast('Enter a valid quantity (max ' + currentBalance + ')', 'error'); return; }
      if (!priceUsd || priceUsd <= 0) { u.showToast('Enter a valid price', 'error'); return; }

      var priceWei = BigInt(Math.round(priceUsd * 1e6));
      var btn = document.getElementById('ls-confirm');
      var statusEl = document.getElementById('ls-status');

      btn.disabled = true;
      btn.textContent = 'Submitting...';
      statusEl.textContent = 'Sending transaction...';
      statusEl.classList.remove('hidden');

      Wallet.listRoyaltyShares(contractAddr, qty, priceWei.toString(), Wallet.USDC_ADDRESS, walletKey === 'sa' ? undefined : 'eoa')
        .then(function () {
          u.showToast('Shares listed for sale!', 'success');
          modal.remove();
          var detailNft = (window.ElaMarket || {}).state && window.ElaMarket.state.detailItem;
          if (detailNft) setTimeout(function () { renderOrderBook(detailNft); }, 2000);
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'List for Sale';
          if (err.message && err.message.indexOf('rejected') === -1) {
            statusEl.textContent = 'Failed: ' + u.decodeContractError(err.message);
          } else {
            statusEl.classList.add('hidden');
          }
        });
    });
  }

  // ── Transfer Shares Modal ──────────────────────

  function openTransferSharesModal(contractAddr, walletKey, currentBalance) {
    var existing = document.getElementById('transfer-shares-modal');
    if (existing) existing.remove();

    var pctLabel = (currentBalance / 10).toFixed(1);

    var modal = document.createElement('div');
    modal.id = 'transfer-shares-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML =
      '<div class="modal-dialog">' +
        '<div class="modal-header">' +
          '<h3>Transfer Royalty Shares</h3>' +
          '<button class="modal-close-btn" id="transfer-shares-close">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<p class="modal-desc">You hold <strong>' + currentBalance + '</strong> royalty tokens (' + pctLabel + '%) from wallet: <strong>' + (walletKey === 'sa' ? 'Smart Account' : 'EOA') + '</strong></p>' +
          '<div class="form-group">' +
            '<label for="ts-recipient">Recipient Address</label>' +
            '<input type="text" id="ts-recipient" placeholder="0x..." class="form-input" />' +
          '</div>' +
          '<div class="form-group">' +
            '<label for="ts-quantity">Quantity to transfer (10 tokens = 1%)</label>' +
            '<input type="number" id="ts-quantity" min="1" max="' + currentBalance + '" step="1" placeholder="e.g. 10" class="form-input" />' +
          '</div>' +
          '<div id="ts-status" class="modal-status hidden"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button id="ts-cancel" class="btn-secondary">Cancel</button>' +
          '<button id="ts-confirm" class="btn-primary">Transfer</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    document.getElementById('transfer-shares-close').addEventListener('click', function () { modal.remove(); });
    document.getElementById('ts-cancel').addEventListener('click', function () { modal.remove(); });

    document.getElementById('ts-confirm').addEventListener('click', function () {
      var recipient = document.getElementById('ts-recipient').value.trim();
      var qty = parseInt(document.getElementById('ts-quantity').value);

      if (!recipient || !ethers.isAddress(recipient)) { u.showToast('Enter a valid recipient address', 'error'); return; }
      if (!qty || qty <= 0 || qty > currentBalance) { u.showToast('Enter a valid quantity (max ' + currentBalance + ')', 'error'); return; }

      var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
      var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();
      if (recipient.toLowerCase() === eoaAddr || recipient.toLowerCase() === saAddr) {
        u.showToast('Cannot transfer to yourself', 'error');
        return;
      }

      var btn = document.getElementById('ts-confirm');
      var statusEl = document.getElementById('ts-status');

      btn.disabled = true;
      btn.textContent = 'Transferring...';
      statusEl.textContent = 'Sending transaction...';
      statusEl.classList.remove('hidden');

      Wallet.transferRoyaltyShares(contractAddr, recipient, qty, walletKey)
        .then(function () {
          u.showToast('Shares transferred!', 'success');
          modal.remove();
          if (typeof ElacityAPI !== 'undefined' && ElacityAPI.clearEarningsCache) ElacityAPI.clearEarningsCache(true);
          var detailNft = (window.ElaMarket || {}).state && window.ElaMarket.state.detailItem;
          if (detailNft) {
            setTimeout(function () {
              renderOrderBook(detailNft);
              if (window.ElaMarket && window.ElaMarket.renderGovernanceSection) window.ElaMarket.renderGovernanceSection(detailNft);
            }, 2000);
          }
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Transfer';
          if (err.message && err.message.indexOf('rejected') === -1) {
            statusEl.textContent = 'Failed: ' + u.decodeContractError(err.message);
          } else {
            statusEl.classList.add('hidden');
          }
        });
    });
  }

  // ── List Access for Resale Modal ───────────────

  function openResellAccessModal(contractAddr, ledger, tokenId, walletKey) {
    var existing = document.getElementById('resell-access-modal');
    if (existing) existing.remove();

    var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
    var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();
    var hasSA = !!saAddr;

    var modal = document.createElement('div');
    modal.id = 'resell-access-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML =
      '<div class="modal-dialog">' +
        '<div class="modal-header">' +
          '<h3>List Access Token for Resale</h3>' +
          '<button class="modal-close-btn" id="resell-close">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<div id="ra-balance-info" style="margin-bottom:12px;padding:10px;background:#f3f4f6;color:#111827;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;">' +
            '<div style="color:#6b7280;">Loading balances...</div>' +
          '</div>' +
          (hasSA ?
            '<div class="form-group">' +
              '<label>List from wallet</label>' +
              '<select id="ra-wallet" class="form-input">' +
                '<option value="sa"' + (walletKey === 'sa' ? ' selected' : '') + '>Agent Account (' + (saAddr ? saAddr.substring(0,6) + '…' + saAddr.slice(-4) : '') + ')</option>' +
                '<option value="eoa"' + (walletKey === 'eoa' ? ' selected' : '') + '>EOA Wallet (' + (eoaAddr ? eoaAddr.substring(0,6) + '…' + eoaAddr.slice(-4) : '') + ')</option>' +
              '</select>' +
            '</div>' : '') +
          '<div class="form-group">' +
            '<label for="ra-quantity">Quantity</label>' +
            '<input type="number" id="ra-quantity" min="1" step="1" value="1" class="form-input" />' +
          '</div>' +
          '<div class="form-group">' +
            '<label for="ra-price">Price per token (USDC)</label>' +
            '<input type="number" id="ra-price" min="0.000001" step="0.01" placeholder="e.g. 0.02" class="form-input" />' +
          '</div>' +
          '<div id="ra-existing-listing" class="hidden" style="margin-top:8px;padding:8px 10px;background:#2d2a1e;border:1px solid #665e3a;border-radius:6px;font-size:12px;color:#eab308;"></div>' +
          '<div id="ra-status" class="modal-status hidden"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button id="ra-cancel" class="btn-secondary">Cancel</button>' +
          '<button id="ra-confirm" class="btn-primary">List for Resale</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    var eoaBal = 0, saBal = 0;
    var eoaListing = null, saListing = null;

    function updateBalanceInfo() {
      var infoEl = document.getElementById('ra-balance-info');
      if (!infoEl) return;
      var html = '';
      if (hasSA) {
        html += '<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span>Agent Account:</span> <strong>' + saBal + ' access token' + (saBal !== 1 ? 's' : '') + '</strong></div>';
      }
      html += '<div style="display:flex;justify-content:space-between;"><span>EOA Wallet:</span> <strong>' + eoaBal + ' access token' + (eoaBal !== 1 ? 's' : '') + '</strong></div>';
      infoEl.innerHTML = html;
    }

    function updateExistingListing() {
      var walletEl = document.getElementById('ra-wallet');
      var sel = walletEl ? walletEl.value : (walletKey || 'sa');
      var listing = sel === 'sa' ? saListing : eoaListing;
      var el = document.getElementById('ra-existing-listing');
      if (!el) return;
      if (listing && listing.quantity > 0) {
        var priceUsd = (parseInt(listing.pricePerToken) / 1e6).toFixed(2);
        el.innerHTML = '⚠ You already have <strong>' + listing.quantity + '</strong> listed at <strong>$' + priceUsd + ' USDC</strong> each from this wallet. A new listing will <strong>replace</strong> the existing one.';
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }

    var fetches = [];
    fetches.push(Wallet.getAccessTokenBalance(contractAddr, eoaAddr).then(function (b) { eoaBal = Number(b); }).catch(function () {}));
    if (hasSA) {
      fetches.push(Wallet.getAccessTokenBalance(contractAddr, saAddr).then(function (b) { saBal = Number(b); }).catch(function () {}));
    }
    fetches.push(Wallet.getAccessListing(contractAddr, Wallet.TOKEN_ID_ACCESS, eoaAddr).then(function (l) { eoaListing = l; }).catch(function () {}));
    if (hasSA) {
      fetches.push(Wallet.getAccessListing(contractAddr, Wallet.TOKEN_ID_ACCESS, saAddr).then(function (l) { saListing = l; }).catch(function () {}));
    }
    function setQtyToBalance() {
      var walletEl = document.getElementById('ra-wallet');
      var sel = walletEl ? walletEl.value : (walletKey || 'sa');
      var bal = sel === 'sa' ? saBal : eoaBal;
      var qtyEl = document.getElementById('ra-quantity');
      if (qtyEl && bal > 0) qtyEl.value = bal;
    }

    Promise.all(fetches).then(function () {
      updateBalanceInfo();
      updateExistingListing();
      setQtyToBalance();
    });

    document.getElementById('resell-close').addEventListener('click', function () { modal.remove(); });
    document.getElementById('ra-cancel').addEventListener('click', function () { modal.remove(); });

    if (hasSA) {
      document.getElementById('ra-wallet').addEventListener('change', function () { updateExistingListing(); setQtyToBalance(); });
    }

    document.getElementById('ra-confirm').addEventListener('click', function () {
      var walletEl = document.getElementById('ra-wallet');
      var selectedWallet = walletEl ? walletEl.value : (walletKey || 'sa');
      var qty = parseInt(document.getElementById('ra-quantity').value);
      var priceUsd = parseFloat(document.getElementById('ra-price').value);
      if (!qty || qty <= 0) { u.showToast('Enter a valid quantity', 'error'); return; }
      if (!priceUsd || priceUsd <= 0) { u.showToast('Enter a valid price', 'error'); return; }

      var maxBal = selectedWallet === 'sa' ? saBal : eoaBal;
      if (qty > maxBal) { u.showToast('You only have ' + maxBal + ' access token(s) in this wallet', 'error'); return; }

      var priceWei = BigInt(Math.round(priceUsd * 1e6));
      var btn = document.getElementById('ra-confirm');
      var statusEl = document.getElementById('ra-status');

      btn.disabled = true;
      btn.textContent = 'Submitting...';
      statusEl.textContent = 'Sending transaction...';
      statusEl.classList.remove('hidden');

      var useWallet = selectedWallet === 'eoa' ? 'eoa' : undefined;

      Wallet.resellAccessToken(ledger, tokenId, qty, priceWei.toString(), Wallet.USDC_ADDRESS, contractAddr, useWallet)
        .then(function () {
          u.showToast('Access token listed for resale!', 'success');
          modal.remove();
          var detailNft = M.state && M.state.detailItem;
          if (detailNft) {
            renderVendorsSection(detailNft);
            if (window.ElacityApp && window.ElacityApp.enrichFromChain) {
              setTimeout(function () { window.ElacityApp.enrichFromChain(detailNft); }, 2000);
            }
          }
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'List for Resale';
          if (err.message && err.message.indexOf('rejected') === -1) {
            statusEl.textContent = 'Failed: ' + u.decodeContractError(err.message);
          } else {
            statusEl.classList.add('hidden');
          }
        });
    });
  }

  // ── Make Offer UI ─────────────────────────────────

  function renderOfferSection(nft) {
    var operative = nft.operative || {};
    var operativeAddr = operative.address || '';
    if (!operativeAddr || !Wallet.isConnected()) return;

    // Free assets (opType === 0) have no listing price and produce no
    // on-chain earnings, so royalty-share offers are meaningless. Skip the
    // entire "Royalty Share Offers / Make Offer" section for free content.
    var opType = (operative.opType != null) ? operative.opType : 0;
    if (opType === 0) {
      var existingFreeOffer = document.getElementById('detail-offer-section');
      if (existingFreeOffer) existingFreeOffer.remove();
      return;
    }

    var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
    var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();
    var walletsToCheck = [eoaAddr, saAddr].filter(Boolean);

    var offerContainer = document.getElementById('detail-offer-section');
    if (!offerContainer) {
      offerContainer = document.createElement('div');
      offerContainer.id = 'detail-offer-section';
      offerContainer.className = 'offer-section';
      var govSection = document.getElementById('detail-governance-section');
      if (govSection) govSection.parentNode.insertBefore(offerContainer, govSection.nextSibling);
    }

    var checks = walletsToCheck.map(function (addr) {
      return Wallet.getActiveOffer(operativeAddr, addr).then(function (offer) {
        return offer ? { address: addr, offer: offer } : null;
      });
    });

    Promise.all(checks).then(function (results) {
      var activeOffer = null;
      for (var i = 0; i < results.length; i++) {
        if (results[i]) { activeOffer = results[i]; break; }
      }

      if (activeOffer) {
        var priceUsd = (Number(activeOffer.offer.pricePerToken) / 1e6).toFixed(4);
        var totalUsd = (Number(activeOffer.offer.quantity) * Number(activeOffer.offer.pricePerToken) / 1e6).toFixed(2);
        var walletLabel = activeOffer.address === saAddr ? 'Agent Account' : 'EOA';
        var cancelWallet = activeOffer.address === saAddr ? 'sa' : 'eoa';

        offerContainer.innerHTML =
          '<div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px;">Your Active Offer</div>' +
          '<div style="background:rgba(59,130,246,0.06);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:13px;">' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">' +
              '<span style="color:var(--text-secondary);">Quantity</span>' +
              '<span style="font-weight:600;">' + activeOffer.offer.quantity + ' tokens (' + (Number(activeOffer.offer.quantity) / 10).toFixed(1) + '%)</span>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">' +
              '<span style="color:var(--text-secondary);">Price / token</span>' +
              '<span style="font-weight:600;">' + priceUsd + ' USDC</span>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:8px;">' +
              '<span style="color:var(--text-secondary);">Total cost</span>' +
              '<span style="font-weight:600;">' + totalUsd + ' USDC</span>' +
            '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">from ' + walletLabel + ' (' + activeOffer.address.substring(0,6) + '...' + activeOffer.address.slice(-4) + ')</div>' +
            '<button id="cancel-active-offer-btn" style="display:inline-flex;align-items:center;justify-content:center;padding:8px 16px;font-size:13px;line-height:1;font-family:inherit;background:#dc2626;color:white;border:none;border-radius:6px;cursor:pointer;width:100%;">Cancel Offer</button>' +
          '</div>';

        document.getElementById('cancel-active-offer-btn').addEventListener('click', function () {
          var btn = this;
          btn.disabled = true;
          btn.textContent = 'Cancelling...';
          Wallet.cancelRoyaltyOffer(operativeAddr, cancelWallet)
            .then(function () {
              u.showToast('Offer cancelled', 'success');
              setTimeout(function () { renderOfferSection(nft); }, 2000);
            })
            .catch(function (err) {
              btn.disabled = false;
              btn.textContent = 'Cancel Offer';
              if (err.message && err.message.indexOf('rejected') === -1) {
                u.showToast('Failed to cancel: ' + u.decodeContractError(err.message), 'error');
              }
            });
        });
        return;
      }

      offerContainer.innerHTML =
        '<div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px;">Royalty Share Offers</div>' +
        '<button id="make-offer-btn" class="btn-primary">Make Offer</button>';

      document.getElementById('make-offer-btn').addEventListener('click', function () {
        openMakeOfferModal(nft);
      });
    }).catch(function () {});
  }

  function openMakeOfferModal(nft) {
    var operative = nft.operative || {};
    var operativeAddr = operative.address || '';

    var existing = document.getElementById('offer-modal');
    if (existing) existing.remove();

    var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
    var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();

    var eoaHasAccess = false;
    var saHasAccess = false;
    var accessChecks = [];
    if (eoaAddr) accessChecks.push(Wallet.checkTradeAccess(operativeAddr, eoaAddr).then(function (ok) { eoaHasAccess = ok; }));
    if (saAddr) accessChecks.push(Wallet.checkTradeAccess(operativeAddr, saAddr).then(function (ok) { saHasAccess = ok; }));

    Promise.all(accessChecks).then(function () {
      if (!eoaHasAccess && !saHasAccess) {
        u.showToast('You need to own an access token for this asset before making royalty offers', 'error');
        return;
      }
      _buildOfferModal(nft, operativeAddr, eoaAddr, saAddr, eoaHasAccess, saHasAccess);
    }).catch(function () {
      _buildOfferModal(nft, operativeAddr, eoaAddr, saAddr, true, true);
    });
  }

  function _buildOfferModal(nft, operativeAddr, eoaAddr, saAddr, eoaHasAccess, saHasAccess) {
    var hasSA = !!saAddr && saHasAccess;
    var hasEOA = !!eoaAddr && eoaHasAccess;
    var selectedWallet = hasSA ? 'sa' : (hasEOA ? 'eoa' : 'sa');
    var eoaUsdcBal = '...';
    var saUsdcBal = '...';

    var walletPickerHtml = '';
    var showBothWallets = hasSA && hasEOA;
    if (showBothWallets) {
      walletPickerHtml =
        '<div class="form-group">' +
          '<label>Pay from wallet</label>' +
          '<div id="offer-wallet-picker" style="display:flex;flex-direction:column;gap:6px;">' +
            '<button type="button" class="offer-wallet-opt' + (selectedWallet === 'sa' ? ' selected' : '') + '" data-wallet="sa" style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:8px;border:2px solid ' + (selectedWallet === 'sa' ? 'var(--accent)' : 'var(--border)') + ';background:' + (selectedWallet === 'sa' ? 'rgba(59,130,246,0.08)' : 'transparent') + ';cursor:pointer;font-size:13px;color:var(--text-primary);text-align:left;">' +
              '<div><strong>Agent Account</strong><br><span style="font-size:11px;color:var(--text-muted);">' + (saAddr ? saAddr.substring(0,6) + '...' + saAddr.slice(-4) : '') + '</span></div>' +
              '<span id="offer-sa-bal" style="font-weight:600;font-size:13px;">' + saUsdcBal + ' USDC</span>' +
            '</button>' +
            '<button type="button" class="offer-wallet-opt' + (selectedWallet === 'eoa' ? ' selected' : '') + '" data-wallet="eoa" style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:8px;border:2px solid ' + (selectedWallet === 'eoa' ? 'var(--accent)' : 'var(--border)') + ';background:' + (selectedWallet === 'eoa' ? 'rgba(59,130,246,0.08)' : 'transparent') + ';cursor:pointer;font-size:13px;color:var(--text-primary);text-align:left;">' +
              '<div><strong>EOA Wallet</strong><br><span style="font-size:11px;color:var(--text-muted);">' + (eoaAddr ? eoaAddr.substring(0,6) + '...' + eoaAddr.slice(-4) : '') + '</span></div>' +
              '<span id="offer-eoa-bal" style="font-weight:600;font-size:13px;">' + eoaUsdcBal + ' USDC</span>' +
            '</button>' +
          '</div>' +
        '</div>';
    } else if (hasSA || hasEOA) {
      var singleWallet = hasSA ? 'sa' : 'eoa';
      var singleLabel = hasSA ? 'Agent Account' : 'EOA Wallet';
      var singleAddr = hasSA ? saAddr : eoaAddr;
      walletPickerHtml =
        '<div class="form-group">' +
          '<label>Paying from</label>' +
          '<div style="padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:13px;color:var(--text-primary);">' +
            '<strong>' + singleLabel + '</strong> <span style="font-size:11px;color:var(--text-muted);">' + (singleAddr ? singleAddr.substring(0,6) + '...' + singleAddr.slice(-4) : '') + '</span>' +
            ' — <span id="offer-' + singleWallet + '-bal" style="font-weight:600;">' + (hasSA ? saUsdcBal : eoaUsdcBal) + ' USDC</span>' +
          '</div>' +
        '</div>';
    }

    var modal = document.createElement('div');
    modal.id = 'offer-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML =
      '<div class="modal-dialog">' +
        '<div class="modal-header">' +
          '<h3>Make Royalty Share Offer</h3>' +
          '<button class="modal-close-btn" id="offer-modal-close">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<p class="modal-desc">' + u.escapeHtml(nft.name || 'Asset') + '</p>' +
          walletPickerHtml +
          '<div class="form-group">' +
            '<label for="offer-quantity">Quantity (10 tokens = 1%)</label>' +
            '<input type="number" id="offer-quantity" min="1" step="1" placeholder="e.g. 10" class="form-input" />' +
          '</div>' +
          '<div class="form-group">' +
            '<label for="offer-price">Price per token (USDC)</label>' +
            '<input type="number" id="offer-price" min="0.01" step="0.01" placeholder="e.g. 5.00" class="form-input" />' +
          '</div>' +
          '<div id="offer-total-cost" style="font-size:12px;color:var(--text-secondary);margin-top:4px;"></div>' +
          '<div id="offer-status" class="modal-status hidden"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button id="offer-cancel-btn" class="btn-secondary">Cancel</button>' +
          '<button id="offer-confirm-btn" class="btn-primary">Submit Offer</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    var fetches = [
      Wallet.getERC20Balance(Wallet.USDC_ADDRESS, eoaAddr).then(function (b) {
        eoaUsdcBal = (Number(b) / 1e6).toFixed(2);
        var el = document.getElementById('offer-eoa-bal');
        if (el) el.textContent = eoaUsdcBal + ' USDC';
      }).catch(function () {})
    ];
    if (hasSA) {
      fetches.push(
        Wallet.getERC20Balance(Wallet.USDC_ADDRESS, saAddr).then(function (b) {
          saUsdcBal = (Number(b) / 1e6).toFixed(2);
          var el = document.getElementById('offer-sa-bal');
          if (el) el.textContent = saUsdcBal + ' USDC';
        }).catch(function () {})
      );
    }
    Promise.all(fetches);

    if (showBothWallets) {
      modal.querySelectorAll('.offer-wallet-opt').forEach(function (btn) {
        btn.addEventListener('click', function () {
          selectedWallet = btn.dataset.wallet;
          modal.querySelectorAll('.offer-wallet-opt').forEach(function (b) {
            b.style.border = '2px solid var(--border)';
            b.style.background = 'transparent';
            b.classList.remove('selected');
          });
          btn.style.border = '2px solid var(--accent)';
          btn.style.background = 'rgba(59,130,246,0.08)';
          btn.classList.add('selected');
        });
      });
    }

    function updateTotalCost() {
      var qty = parseInt(document.getElementById('offer-quantity').value) || 0;
      var price = parseFloat(document.getElementById('offer-price').value) || 0;
      var el = document.getElementById('offer-total-cost');
      if (el) el.textContent = qty > 0 && price > 0 ? 'Total cost: ' + (qty * price).toFixed(2) + ' USDC' : '';
    }
    document.getElementById('offer-quantity').addEventListener('input', updateTotalCost);
    document.getElementById('offer-price').addEventListener('input', updateTotalCost);

    document.getElementById('offer-modal-close').addEventListener('click', function () { modal.remove(); });
    document.getElementById('offer-cancel-btn').addEventListener('click', function () { modal.remove(); });

    document.getElementById('offer-confirm-btn').addEventListener('click', function () {
      var qty = parseInt(document.getElementById('offer-quantity').value);
      var priceUsd = parseFloat(document.getElementById('offer-price').value);
      if (!qty || qty <= 0) { u.showToast('Enter a valid quantity', 'error'); return; }
      if (!priceUsd || priceUsd <= 0) { u.showToast('Enter a valid price', 'error'); return; }

      var totalCost = qty * priceUsd;
      var walletBal = selectedWallet === 'sa' ? parseFloat(saUsdcBal) : parseFloat(eoaUsdcBal);
      if (!isNaN(walletBal) && totalCost > walletBal) {
        u.showToast('Insufficient USDC balance (' + walletBal.toFixed(2) + ' available)', 'error');
        return;
      }

      var pricePerToken = BigInt(Math.round(priceUsd * 1e6));
      var btn = document.getElementById('offer-confirm-btn');
      var statusEl = document.getElementById('offer-status');

      btn.disabled = true;
      btn.textContent = 'Approving USDC...';
      statusEl.textContent = 'Sending approval...';
      statusEl.classList.remove('hidden');

      Wallet.createRoyaltyOffer(operativeAddr, qty, pricePerToken.toString(), Wallet.USDC_ADDRESS, selectedWallet)
        .then(function (result) {
          var isPending = result && result._uaPending;

          if (isPending) {
            btn.disabled = true;
            btn.textContent = 'Confirming...';
            statusEl.textContent = 'Transaction sent — waiting for on-chain confirmation...';
            statusEl.classList.remove('hidden');

            var txId = result && result.transactionId;
            var pollCount = 0;
            var maxPolls = 20;
            var pollInterval = 3000;

            function pollOffer() {
              pollCount++;
              Wallet.getRoyaltyShareBalance(operativeAddr, Wallet.getSmartAccountAddress() || Wallet.getAddress())
                .then(function () {
                  return Wallet.getProvider().request({
                    method: 'eth_call',
                    params: [{ to: Wallet.USDC_ADDRESS, data: new ethers.Interface(['function balanceOf(address) view returns (uint256)']).encodeFunctionData('balanceOf', [Wallet.getSmartAccountAddress()]) }, 'latest']
                  });
                })
                .then(function () {
                  if (pollCount >= maxPolls) {
                    statusEl.innerHTML = 'Offer may still be processing. ' +
                      (txId ? '<a href="https://universalx.app/activity/details?id=' + txId + '" target="_blank" style="color:var(--accent);">Check status</a>' : 'Please check your Earnings tab later.');
                    setTimeout(function () { modal.remove(); }, 5000);
                    return;
                  }
                  setTimeout(pollOffer, pollInterval);
                });
            }

            var checkTimer = setInterval(function () {
              ElacityAPI.searchOfferEvents(null, null, 10).then(function (events) {
                var found = events.some(function (e) {
                  var from = (e.from && e.from.address || '').toLowerCase();
                  var sa = (Wallet.getSmartAccountAddress() || '').toLowerCase();
                  var eoa = (Wallet.getAddress() || '').toLowerCase();
                  return from === sa || from === eoa;
                });
                if (found) {
                  clearInterval(checkTimer);
                  u.showToast('Offer confirmed on-chain!', 'success');
                  modal.remove();
                  var detailNft = (window.ElaMarket || {}).state && window.ElaMarket.state.detailItem;
                  if (detailNft) renderOfferSection(detailNft);
                  if (state.earningsTab === 'offers') loadEarningsOffers();
                }
              }).catch(function () {});
            }, 5000);

            setTimeout(function () {
              clearInterval(checkTimer);
              if (document.getElementById('offer-modal')) {
                statusEl.innerHTML = 'Offer may still be processing. ' +
                  (txId ? '<a href="https://universalx.app/activity/details?id=' + txId + '" target="_blank" style="color:var(--accent);">Check status</a>' : 'Check your Earnings tab later.');
                setTimeout(function () { modal.remove(); }, 6000);
              }
            }, 60000);

            return;
          }

          u.showToast('Offer submitted!', 'success');
          modal.remove();
          var detailNft = (window.ElaMarket || {}).state && window.ElaMarket.state.detailItem;
          if (detailNft) setTimeout(function () { renderOfferSection(detailNft); }, 2000);
          if (state.earningsTab === 'offers') setTimeout(loadEarningsOffers, 3000);
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Submit Offer';
          var msg = err.message || '';
          if (msg.indexOf('rejected') !== -1 || msg.indexOf('denied') !== -1) {
            statusEl.classList.add('hidden');
            return;
          }
          if (msg.indexOf('simulation failed') !== -1 || msg.indexOf('NoOverrideError') !== -1) {
            statusEl.textContent = 'You already have an active offer for this asset. Cancel it first.';
          } else if (msg.indexOf('TradeActionRestricted') !== -1) {
            statusEl.textContent = 'This wallet does not have trade access. You need to own an access token first.';
          } else {
            statusEl.textContent = 'Failed: ' + u.decodeContractError(msg);
          }
        });
    });
  }

  // ── Offers Tab in Earnings ────────────────────────

  function getOfferTokenName(evt) {
    if (evt.metadata && evt.metadata.name) return evt.metadata.name;
    if (evt.token && evt.token.name) return evt.token.name;
    var addr = (evt.metadata && evt.metadata.contractAddress) ||
               (evt.token && (evt.token.contractAddress || evt.token.address)) || '';
    if (addr) return u.formatAddress(addr);
    return 'Unknown token';
  }

  function getOfferContractAddr(evt) {
    return (evt.metadata && evt.metadata.contractAddress) ||
           (evt.token && (evt.token.contractAddress || evt.token.address)) || '';
  }

  function loadEarningsOffers() {
    var listEl = document.getElementById('earnings-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="loading-indicator"><div class="spinner"></div><span>Loading offers...</span></div>';

    Promise.all([
      ElacityAPI.searchOfferEvents(null, null, 50).catch(function () { return []; }),
      ElacityAPI.searchIncomingOfferEvents(null, null, 50).catch(function () { return []; }),
      ElacityAPI.getV3Operatives()
    ]).then(function (results) {
      var allOutgoing = results[0] || [];
      var allIncoming = results[1] || [];
      var v3Set = results[2];

      var outgoing = allOutgoing.filter(function (evt) {
        var addr = getOfferContractAddr(evt);
        return addr && v3Set.has(addr.toLowerCase());
      });
      var incoming = allIncoming.filter(function (evt) {
        var addr = getOfferContractAddr(evt);
        return addr && v3Set.has(addr.toLowerCase());
      });

      if (outgoing.length === 0 && incoming.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><p>No offers found</p></div>';
        return;
      }

      renderOffersList(listEl, outgoing, incoming);
    });
  }

  function renderOffersList(listEl, outgoing, incoming) {
      var html = '';

      if (outgoing.length > 0) {
        html += '<div style="font-size:12px;font-weight:600;color:var(--text-secondary);padding:8px 0;">Outgoing Offers</div>';
        outgoing.forEach(function (evt) {
          var tokenAddr = getOfferContractAddr(evt);
          var tokenName = getOfferTokenName(evt);
          var price = evt.price ? u.formatPrice(evt.price, evt.paymentToken) : '';
          var offerFrom = (evt.from && evt.from.address) || '';
          html += '<div class="offer-row">';
          html += '<span style="flex:1;font-weight:500;">' + u.escapeHtml(tokenName) + '</span>';
          html += '<span>x' + (evt.quantity || 1) + '</span>';
          if (price) html += '<span style="font-weight:600;">' + price + '</span>';
          html += '<span style="font-size:11px;color:var(--text-tertiary);">' + (evt.createdAt ? new Date(evt.createdAt).toLocaleDateString() : '') + '</span>';
          if (tokenAddr) {
            html += '<button class="earnings-withdraw-btn" data-action="cancel-offer" data-contract="' + u.escapeHtml(tokenAddr) + '" data-offerer="' + u.escapeHtml(offerFrom) + '">Cancel</button>';
          }
          html += '</div>';
        });
      }

      if (incoming.length > 0) {
        html += '<div style="font-size:12px;font-weight:600;color:var(--text-secondary);padding:8px 0;margin-top:8px;">Incoming Offers</div>';
        incoming.forEach(function (evt) {
          var tokenAddr = getOfferContractAddr(evt);
          var tokenName = getOfferTokenName(evt);
          var price = evt.price ? u.formatPrice(evt.price, evt.paymentToken) : '';
          var fromAddr = (evt.from && evt.from.address) || '';
          html += '<div class="offer-row">';
          html += '<span style="flex:1;font-weight:500;">' + u.escapeHtml(tokenName) + '</span>';
          html += '<span style="font-size:11px;">from ' + u.formatAddress(fromAddr) + '</span>';
          html += '<span>x' + (evt.quantity || 1) + '</span>';
          if (price) html += '<span style="font-weight:600;">' + price + '</span>';
          if (tokenAddr && fromAddr) {
            html += '<button class="earnings-withdraw-btn" data-action="accept-offer" data-contract="' + u.escapeHtml(tokenAddr) + '" data-from="' + u.escapeHtml(fromAddr) + '" data-qty="' + (evt.quantity || 1) + '" style="background:var(--success);">Accept</button>';
          }
          html += '</div>';
        });
      }

      listEl.innerHTML = html;

      var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
      var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();
      var hasSA = Wallet.hasSmartAccount() && saAddr && saAddr !== eoaAddr;

      listEl.querySelectorAll('[data-action="cancel-offer"]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var addr = btn.dataset.contract;
          var offerer = (btn.dataset.offerer || '').toLowerCase();
          var cancelWallet = (hasSA && offerer === saAddr) ? 'sa' : undefined;
          btn.disabled = true;
          btn.textContent = '...';
          Wallet.cancelRoyaltyOffer(addr, cancelWallet).then(function () {
            u.showToast('Offer cancelled', 'success');
            btn.parentNode.remove();
            if (typeof ElacityAPI !== 'undefined' && ElacityAPI.clearEarningsCache) ElacityAPI.clearEarningsCache(true);
            setTimeout(updateEarningsBadge, 3000);
          }).catch(function (err) {
            btn.disabled = false;
            btn.textContent = 'Cancel';
            if (err.message && err.message.indexOf('rejected') === -1) {
              u.showToast('Failed: ' + u.decodeContractError(err.message), 'error');
            }
          });
        });
      });

      listEl.querySelectorAll('[data-action="accept-offer"]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var addr = btn.dataset.contract;
          var from = btn.dataset.from;
          var qty = parseInt(btn.dataset.qty) || 1;
          btn.disabled = true;
          btn.textContent = 'Checking...';

          var detectWallet = Promise.resolve(undefined);
          if (hasSA) {
            detectWallet = Wallet.getRoyaltyShareBalance(addr, saAddr)
              .then(function (bal) { return Number(bal) >= qty ? 'sa' : undefined; })
              .catch(function () { return undefined; });
          }
          detectWallet.then(function (acceptWallet) {
            btn.textContent = '...';
            return Wallet.acceptRoyaltyOffer(from, addr, qty, acceptWallet);
          }).then(function () {
            u.showToast('Offer accepted!', 'success');
            btn.parentNode.remove();
            if (typeof ElacityAPI !== 'undefined' && ElacityAPI.clearEarningsCache) ElacityAPI.clearEarningsCache(true);
            setTimeout(updateEarningsBadge, 3000);
          }).catch(function (err) {
            btn.disabled = false;
            btn.textContent = 'Accept';
            if (err.message && err.message.indexOf('rejected') === -1) {
              u.showToast('Failed: ' + u.decodeContractError(err.message), 'error');
            }
          });
        });
      });
  }

  // ── Royalty Order Book (Asset Detail) ──────────────

  function renderOrderBook(nft) {
    var operative = nft.operative || {};
    var operativeAddr = operative.address || '';
    if (!operativeAddr) return;

    var section = document.getElementById('detail-orderbook-section');
    var container = document.getElementById('orderbook-listings');
    if (!section || !container) return;

    // Free assets (opType === 0) have no royalty-share market because there's
    // no revenue to distribute. Keep the "Royalty Market" section hidden.
    var opType = (operative.opType != null) ? operative.opType : 0;
    if (opType === 0) {
      section.classList.add('hidden');
      return;
    }

    container.innerHTML = '<div class="loading-indicator"><div class="spinner"></div></div>';
    section.classList.remove('hidden');

    Wallet.getRoyaltySellers(operativeAddr).then(function (sellers) {
      if (!sellers || sellers.length === 0) {
        container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-tertiary);font-size:12px;">No royalty shares listed for sale</div>';
        return;
      }

      var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
      var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();

      var listingPromises = sellers.map(function (seller) {
        return Wallet.getRoyaltyListing(operativeAddr, seller).then(function (listing) {
          if (!listing || listing.quantity <= 0) return null;
          return { seller: seller, quantity: listing.quantity, pricePerToken: listing.pricePerToken, payToken: listing.payToken };
        }).catch(function () { return null; });
      });

      Promise.all(listingPromises).then(function (listings) {
        var valid = listings.filter(function (l) { return l !== null; });
        if (valid.length === 0) {
          container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-tertiary);font-size:12px;">No active royalty listings</div>';
          return;
        }

        valid.sort(function (a, b) { return Number(BigInt(a.pricePerToken) - BigInt(b.pricePerToken)); });

        var html = '<div class="orderbook-header" style="display:grid;grid-template-columns:1fr 80px 100px 90px;gap:8px;padding:8px 12px;font-size:11px;font-weight:600;color:var(--text-tertiary);border-bottom:1px solid var(--border);">';
        html += '<span>Seller</span><span>Qty (%)</span><span>Price/token</span><span></span>';
        html += '</div>';

        valid.forEach(function (l) {
          var isSelf = l.seller.toLowerCase() === eoaAddr || l.seller.toLowerCase() === saAddr;
          var priceFmt = (Number(l.pricePerToken) / 1e6).toFixed(2);
          var pctStr = (l.quantity / 10).toFixed(1);

          html += '<div class="orderbook-row" style="display:grid;grid-template-columns:1fr 80px 100px 90px;gap:8px;padding:10px 12px;align-items:center;border-bottom:1px solid var(--border-light);font-size:12px;">';
          html += '<span style="font-weight:500;">' + u.formatAddress(l.seller) + (isSelf ? ' <span style="color:var(--accent);font-size:10px;">(you)</span>' : '') + '</span>';
          html += '<span>' + l.quantity + ' (' + pctStr + '%)</span>';
          html += '<span style="font-weight:600;">$' + priceFmt + '</span>';

          if (isSelf) {
            html += '<button class="action-btn orderbook-cancel" data-seller="' + u.escapeHtml(l.seller) + '" data-qty="' + l.quantity + '" style="font-size:11px;padding:4px 10px;color:#ef4444;border-color:#ef4444;">Cancel</button>';
          } else {
            html += '<button class="action-btn orderbook-buy" data-seller="' + u.escapeHtml(l.seller) + '" data-operative="' + u.escapeHtml(operativeAddr) + '" data-qty="' + l.quantity + '" data-price="' + l.pricePerToken + '" data-paytoken="' + u.escapeHtml(l.payToken) + '" style="font-size:11px;padding:4px 10px;background:var(--accent);color:#fff;border-color:var(--accent);">Buy</button>';
          }
          html += '</div>';
        });

        if (Wallet.isConnected()) {
          html += '<div style="padding:10px 12px;">';
          html += '<button class="btn-primary orderbook-make-offer" data-operative="' + u.escapeHtml(operativeAddr) + '" style="width:100%;font-size:12px;">Make Offer for Royalty Shares</button>';
          html += '</div>';
        }

        container.innerHTML = html;

        container.querySelectorAll('.orderbook-buy').forEach(function (btn) {
          btn.addEventListener('click', function () {
            openBuyRoyaltyModal(btn.dataset.seller, btn.dataset.operative, parseInt(btn.dataset.qty), btn.dataset.price, btn.dataset.paytoken);
          });
        });

        container.querySelectorAll('.orderbook-cancel').forEach(function (btn) {
          btn.addEventListener('click', function () {
            btn.disabled = true;
            btn.textContent = '...';
            var qty = parseInt(btn.dataset.qty);
            var sellerLower = (btn.dataset.seller || '').toLowerCase();
            var cancelWallet = (Wallet.hasSmartAccount() && sellerLower === saAddr) ? 'sa' : undefined;
            Wallet.cancelRoyaltyListing(operativeAddr, qty, cancelWallet).then(function () {
              u.showToast('Listing cancelled', 'success');
              renderOrderBook(nft);
              if (window.ElaMarket && window.ElaMarket.renderGovernanceSection) {
                setTimeout(function () { window.ElaMarket.renderGovernanceSection(nft); }, 2000);
              }
            }).catch(function (err) {
              btn.disabled = false;
              btn.textContent = 'Cancel';
              if (err.message && err.message.indexOf('rejected') === -1) {
                u.showToast('Failed: ' + u.decodeContractError(err.message), 'error');
              }
            });
          });
        });

        container.querySelectorAll('.orderbook-make-offer').forEach(function (btn) {
          btn.addEventListener('click', function () {
            openMakeOfferModal(nft);
          });
        });
      });
    }).catch(function (err) {
      container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-tertiary);font-size:12px;">Failed to load: ' + u.escapeHtml(err.message) + '</div>';
    });
  }

  // ── Buy Royalty Shares Modal ─────────────────────

  function openBuyRoyaltyModal(sellerAddr, operativeAddr, maxQty, pricePerToken, payToken) {
    var existing = document.getElementById('buy-royalty-modal');
    if (existing) existing.remove();

    var priceFmt = (Number(pricePerToken) / 1e6).toFixed(2);
    var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
    var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();

    if (sellerAddr.toLowerCase() === eoaAddr || sellerAddr.toLowerCase() === saAddr) {
      u.showToast('Cannot buy your own listing', 'error');
      return;
    }

    var modal = document.createElement('div');
    modal.id = 'buy-royalty-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML =
      '<div class="modal-dialog">' +
        '<div class="modal-header">' +
          '<h3>Buy Royalty Shares</h3>' +
          '<button class="modal-close-btn" id="buy-royalty-close">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<p class="modal-desc">Seller: ' + u.formatAddress(sellerAddr) + ' — $' + priceFmt + ' per token</p>' +
          '<div class="form-group">' +
            '<label for="br-quantity">Quantity (max ' + maxQty + ', 10 tokens = 1%)</label>' +
            '<input type="number" id="br-quantity" min="1" max="' + maxQty + '" step="1" value="' + maxQty + '" class="form-input" />' +
          '</div>' +
          '<div id="br-total" style="font-size:13px;font-weight:600;padding:6px 0;">Total: $' + (maxQty * Number(pricePerToken) / 1e6).toFixed(2) + ' USDC</div>' +
          '<div id="br-status" class="modal-status hidden"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button id="br-cancel" class="btn-secondary">Cancel</button>' +
          '<button id="br-confirm" class="btn-primary">Buy Now</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    var qtyInput = document.getElementById('br-quantity');
    var totalEl = document.getElementById('br-total');

    qtyInput.addEventListener('input', function () {
      var q = parseInt(qtyInput.value) || 0;
      var total = (q * Number(pricePerToken) / 1e6).toFixed(2);
      totalEl.textContent = 'Total: $' + total + ' USDC';
    });

    document.getElementById('buy-royalty-close').addEventListener('click', function () { modal.remove(); });
    document.getElementById('br-cancel').addEventListener('click', function () { modal.remove(); });

    document.getElementById('br-confirm').addEventListener('click', function () {
      var qty = parseInt(qtyInput.value);
      if (!qty || qty <= 0 || qty > maxQty) { u.showToast('Enter a valid quantity (max ' + maxQty + ')', 'error'); return; }

      var totalPrice = BigInt(qty) * BigInt(pricePerToken);
      var btn = document.getElementById('br-confirm');
      var statusEl = document.getElementById('br-status');

      btn.disabled = true;
      btn.textContent = 'Processing...';
      statusEl.textContent = 'Sending transaction...';
      statusEl.classList.remove('hidden');

      Wallet.buyRoyaltyShares(sellerAddr, operativeAddr, qty, totalPrice.toString(), payToken)
        .then(function () {
          u.showToast('Royalty shares purchased!', 'success');
          modal.remove();
          if (typeof ElacityAPI !== 'undefined' && ElacityAPI.clearEarningsCache) ElacityAPI.clearEarningsCache(true);
          var detailNft = (window.ElaMarket || {}).state && window.ElaMarket.state.detailItem;
          if (detailNft) {
            setTimeout(function () {
              renderOrderBook(detailNft);
              if (window.ElaMarket && window.ElaMarket.renderGovernanceSection) window.ElaMarket.renderGovernanceSection(detailNft);
            }, 2000);
          }
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Buy Now';
          if (err.message && err.message.indexOf('rejected') === -1) {
            statusEl.textContent = 'Failed: ' + u.decodeContractError(err.message);
          } else {
            statusEl.classList.add('hidden');
          }
        });
    });
  }

  // ── Vendors (Access Resale) Section ──────────────

  function renderVendorsSection(nft) {
    var operative = nft.operative || {};
    var operativeAddr = operative.address || '';
    if (!operativeAddr) return;

    var section = document.getElementById('detail-vendors-section');
    var container = document.getElementById('vendors-listings');
    if (!section || !container) return;

    var tokenId = (nft.tokenId && nft.tokenId.hexTokenID) || nft.tokenId || '0';
    var ledger = nft.ledger || nft.address || '';

    container.innerHTML = '<div class="loading-indicator"><div class="spinner"></div></div>';

    Wallet.getAccessSellers(operativeAddr, tokenId).then(function (sellers) {
      if (!sellers || sellers.length === 0) {
        section.classList.add('hidden');
        return;
      }

      section.classList.remove('hidden');

      var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
      var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();

      var listingPromises = sellers.map(function (seller) {
        return Wallet.getAccessListing(operativeAddr, tokenId, seller).then(function (listing) {
          if (!listing || listing.quantity <= 0) return null;
          return { seller: seller, quantity: listing.quantity, pricePerToken: listing.pricePerToken, payToken: listing.payToken };
        }).catch(function () { return null; });
      });

      Promise.all(listingPromises).then(function (listings) {
        var valid = listings.filter(function (l) { return l !== null; });
        if (valid.length === 0) {
          section.classList.add('hidden');
          return;
        }

        valid.sort(function (a, b) { return Number(BigInt(a.pricePerToken) - BigInt(b.pricePerToken)); });

        var html = '<div class="vendor-grid-header">';
        html += '<span>Seller</span><span>Qty</span><span>Price</span><span></span>';
        html += '</div>';

        valid.forEach(function (l) {
          var isSelf = l.seller.toLowerCase() === eoaAddr || l.seller.toLowerCase() === saAddr;
          var priceFmt = (Number(l.pricePerToken) / 1e6).toFixed(4);

          html += '<div class="vendor-grid-row">';
          html += '<span>' + u.formatAddress(l.seller) + (isSelf ? ' <span style="color:var(--accent);font-size:10px;">(you)</span>' : '') + '</span>';
          html += '<span>' + l.quantity + '</span>';
          html += '<span class="vendor-price">$' + priceFmt + '</span>';

          if (isSelf) {
            html += '<button class="action-btn vendor-cancel" data-operative="' + u.escapeHtml(operativeAddr) + '" data-tokenid="' + u.escapeHtml(tokenId) + '" data-qty="' + l.quantity + '" data-seller="' + u.escapeHtml(l.seller) + '" style="font-size:11px;padding:4px 10px;color:#ef4444;border-color:#ef4444;">Cancel</button>';
          } else {
            html += '<div class="vendor-buy-group">' +
              '<input type="number" class="vendor-qty-input" value="1" min="1" max="' + l.quantity + '" title="Quantity" />' +
              '<button class="action-btn vendor-buy" data-seller="' + u.escapeHtml(l.seller) + '" data-operative="' + u.escapeHtml(operativeAddr) + '" data-ledger="' + u.escapeHtml(ledger) + '" data-tokenid="' + u.escapeHtml(tokenId) + '" data-max-qty="' + l.quantity + '" data-price="' + l.pricePerToken + '" data-paytoken="' + u.escapeHtml(l.payToken) + '" style="font-size:11px;padding:4px 10px;background:var(--accent);color:#fff;border-color:var(--accent);">Buy</button>' +
              '</div>';
          }
          html += '</div>';
        });

        container.innerHTML = html;

        container.querySelectorAll('.vendor-buy').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var group = btn.closest('.vendor-buy-group');
            var qtyInput = group ? group.querySelector('.vendor-qty-input') : null;
            var qty = qtyInput ? (parseInt(qtyInput.value, 10) || 1) : 1;
            var maxQty = parseInt(btn.dataset.maxQty) || 1;
            if (qty < 1) qty = 1;
            if (qty > maxQty) qty = maxQty;
            btn.disabled = true;
            btn.textContent = '...';
            Wallet.buyAccess(
              Wallet.AUTHORITY_GATEWAY_ADDRESS,
              btn.dataset.seller,
              btn.dataset.ledger,
              btn.dataset.tokenid,
              String(qty),
              btn.dataset.price,
              btn.dataset.paytoken,
              btn.dataset.operative
            ).then(function (result) {
                u.showToast(result && result._uaPending ? 'Purchase submitted — settling on-chain' : 'Access token purchased!', 'success');
                renderVendorsSection(nft);
                if (window.ElaMarket && window.ElaMarket.enrichFromChain) {
                  setTimeout(function () { window.ElaMarket.enrichFromChain(nft); }, 2000);
                }
              })
              .catch(function (err) {
                btn.disabled = false;
                btn.textContent = 'Buy';
                if (err.message && err.message.indexOf('rejected') === -1) {
                  u.showToast('Failed: ' + u.decodeContractError(err.message), 'error');
                }
              });
          });
        });

        container.querySelectorAll('.vendor-cancel').forEach(function (btn) {
          btn.addEventListener('click', function () {
            btn.disabled = true;
            btn.textContent = '...';
            var sellerLower = (btn.dataset.seller || '').toLowerCase();
            var cancelWallet = (Wallet.hasSmartAccount() && sellerLower === saAddr) ? 'sa' : undefined;
            Wallet.cancelAccessListing(btn.dataset.operative, btn.dataset.tokenid, parseInt(btn.dataset.qty), cancelWallet)
              .then(function () {
                u.showToast('Listing cancelled', 'success');
                renderVendorsSection(nft);
                if (window.ElaMarket && window.ElaMarket.enrichFromChain) {
                  setTimeout(function () { window.ElaMarket.enrichFromChain(nft); }, 2000);
                }
              })
              .catch(function (err) {
                btn.disabled = false;
                btn.textContent = 'Cancel';
                if (err.message && err.message.indexOf('rejected') === -1) {
                  u.showToast('Failed: ' + u.decodeContractError(err.message), 'error');
                }
              });
          });
        });
      });
    }).catch(function () {
      section.classList.add('hidden');
    });
  }

  // ── Distribution Rights Display ───────────────────

  function renderDistributionRights(nft) {
    var operative = nft.operative || {};
    var operativeAddr = operative.address || '';
    if (!operativeAddr || !Wallet.isConnected()) return;

    var eoaAddr = Wallet.getAddress() || '';

    Wallet.getDistributionBalance(operativeAddr, eoaAddr).then(function (bal) {
      var distBal = parseInt(bal) || 0;
      if (distBal <= 0) return;

      var govEl = document.getElementById('detail-governance');
      if (!govEl) return;

      var distEl = document.getElementById('detail-distribution');
      if (!distEl) {
        distEl = document.createElement('div');
        distEl.id = 'detail-distribution';
        distEl.style.cssText = 'margin-top:8px;padding:8px 12px;background:rgba(99,102,241,0.06);border:1px solid rgba(99,102,241,0.2);border-radius:8px;font-size:12px;';
        govEl.appendChild(distEl);
      }
      distEl.innerHTML = '<span style="font-weight:600;color:var(--accent);">Distribution Rights:</span> ' + distBal + ' tokens';
    }).catch(function () {});
  }

  // ── Asset Owner Actions (Edit Price / Delist) ──────

  function renderAssetOwnerActions(nft) {
    var operative = nft.operative || {};
    var operativeAddr = operative.address || '';
    if (!operativeAddr || !Wallet.isConnected()) return;

    var publisherAddr = (nft.metadata && nft.metadata.properties && nft.metadata.properties.publisher && nft.metadata.properties.publisher.address) || '';
    var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
    var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();
    var isPublisher = publisherAddr && (publisherAddr.toLowerCase() === eoaAddr || publisherAddr.toLowerCase() === saAddr);

    if (!isPublisher) return;

    // Free assets (opType === 0) have no listing price, no marketplace
    // listing to delist, and produce no on-chain earnings. Showing the
    // Publisher Actions strip with Edit Price / Delist / Earnings buttons
    // is misleading — every button is a no-op or error. The "Asset is
    // published" toggle (rendered separately by renderPublishToggle) is
    // the only meaningful publisher control for free content.
    var opType = (operative.opType != null) ? operative.opType : 0;
    if (opType === 0) {
      var freeStrip = document.getElementById('publisher-action-strip');
      if (freeStrip) freeStrip.remove();
      return;
    }

    var existingStrip = document.getElementById('publisher-action-strip');
    if (existingStrip) existingStrip.remove();

    var tokenId = (nft.tokenId && nft.tokenId.hexTokenID) || nft.tokenId || '0';
    var ownerActions = document.getElementById('detail-owner-actions');
    if (!ownerActions) return;

    var strip = document.createElement('div');
    strip.id = 'publisher-action-strip';
    strip.className = 'publisher-action-strip';
    strip.innerHTML =
      '<div class="publisher-strip-label">Publisher Actions</div>' +
      '<div class="publisher-strip-btns">' +
        '<button id="publisher-edit-price-btn" class="action-btn action-edit-price" title="Update listing price">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>' +
          '<span>Edit Price</span>' +
        '</button>' +
        '<button id="publisher-delist-btn" class="action-btn action-delist" title="Remove listing">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' +
          '<span>Delist</span>' +
        '</button>' +
        '<button id="publisher-earnings-btn" class="action-btn action-earnings" title="View earnings for this asset">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' +
          '<span>Earnings</span>' +
        '</button>' +
      '</div>';

    ownerActions.parentNode.insertBefore(strip, ownerActions.nextSibling);

    document.getElementById('publisher-edit-price-btn').addEventListener('click', function () {
      var resellBtn = document.getElementById('resell-btn');
      if (resellBtn) resellBtn.click();
    });

    document.getElementById('publisher-delist-btn').addEventListener('click', function () {
      if (!confirm('Remove your listing for this asset? You can re-list later.')) return;
      var btn = this;
      btn.disabled = true;
      btn.querySelector('span').textContent = 'Finding listing...';

      var eoaLower = eoaAddr.toLowerCase();
      var saLower = saAddr.toLowerCase();
      var hasSA = Wallet.hasSmartAccount() && saLower && saLower !== eoaLower;
      var fetches = [
        Wallet.getAccessListing(operativeAddr, Wallet.TOKEN_ID_ACCESS, eoaAddr).catch(function () { return null; })
      ];
      if (hasSA) {
        fetches.push(Wallet.getAccessListing(operativeAddr, Wallet.TOKEN_ID_ACCESS, saAddr).catch(function () { return null; }));
      }

      Promise.all(fetches).then(function (results) {
        var eoaListing = results[0];
        var saListing = hasSA ? results[1] : null;
        var listing = null;
        var walletKey = 'eoa';
        if (saListing && saListing.quantity > 0) { listing = saListing; walletKey = 'sa'; }
        if (eoaListing && eoaListing.quantity > 0) { listing = eoaListing; walletKey = 'eoa'; }
        if (!listing || !listing.quantity) {
          u.showToast('No active listing found', 'error');
          btn.disabled = false;
          btn.querySelector('span').textContent = 'Delist';
          return;
        }
        btn.querySelector('span').textContent = 'Delisting...';
        var fromWallet = walletKey === 'sa' ? 'sa' : undefined;
        return Wallet.cancelAccessListing(operativeAddr, tokenId, listing.quantity, fromWallet);
      }).then(function () {
        u.showToast('Listing removed', 'success');
        strip.remove();
        renderVendorsSection(nft);
        if (window.ElaMarket && window.ElaMarket.enrichFromChain) {
          setTimeout(function () { window.ElaMarket.enrichFromChain(nft); }, 2000);
        }
      }).catch(function (err) {
        u.showToast('Delist failed: ' + (err.message || err), 'error');
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Delist';
      });
    });

    document.getElementById('publisher-earnings-btn').addEventListener('click', function () {
      if (window.ElaMarket && window.ElaMarket.switchView) {
        window.ElaMarket.switchView('earnings');
      }
    });
  }

  // ── Hook into detail rendering via custom event ────

  window.addEventListener('ela-detail-rendered', function (e) {
    var nft = e.detail && e.detail.nft;
    if (!nft) return;
    renderActivitySection(nft);
    renderPublishToggle(nft);
    renderAssetOwnerActions(nft);
    renderOfferSection(nft);
    renderOrderBook(nft);
    renderVendorsSection(nft);
    renderDistributionRights(nft);
  });

  // ── Hook into earnings rendering ──────────────────

  function retryEnhance(attempt) {
    var listEl = document.getElementById('earnings-list');
    var items = listEl ? listEl.querySelectorAll('.earnings-item:not([data-enhanced])') : [];
    if (items.length > 0) {
      enhanceEarningsItems();
      return;
    }
    if (attempt < 6) {
      setTimeout(function () { retryEnhance(attempt + 1); }, 500 + attempt * 300);
    }
  }

  var _origLoadEarningsData = M.loadEarningsData;
  if (_origLoadEarningsData) {
    window.ElaMarket.loadEarningsData = function (category) {
      _origLoadEarningsData(category);
      retryEnhance(0);
    };
  }

  // ── Add Offers tab to Earnings ────────────────────

  function setupExtraTabs() {
    var tabsEl = document.getElementById('earnings-tabs');
    if (!tabsEl || tabsEl.dataset.extrasAdded) return;
    tabsEl.dataset.extrasAdded = '1';

    // Offers tab
    var offersTab = document.createElement('button');
    offersTab.className = 'earnings-tab';
    offersTab.dataset.tab = 'offers';
    offersTab.textContent = 'Offers';
    tabsEl.appendChild(offersTab);

    offersTab.addEventListener('click', function (e) {
      e.stopPropagation();
      tabsEl.querySelectorAll('.earnings-tab').forEach(function (t) { t.classList.remove('active'); });
      offersTab.classList.add('active');
      state.earningsTab = 'offers';
      loadEarningsOffers();
    });

    updateTabBadges();
  }

  // ── My Channels (Earnings tab) ──────────────────────

  function loadMyChannels() {
    var listEl = document.getElementById('earnings-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="loading-indicator"><div class="spinner"></div><span>Loading your channels...</span></div>';

    var summaryEl = document.getElementById('earnings-summary');
    if (summaryEl) summaryEl.classList.add('hidden');
    var emptyEl = document.getElementById('earnings-empty');
    if (emptyEl) emptyEl.classList.add('hidden');

    var eoaAddr = Wallet.getAddress() || '';
    var saAddr = Wallet.getSmartAccountAddress() || '';
    var fetchPromises = [ElacityAPI.fetchManagedChannels(eoaAddr)];
    if (saAddr && saAddr.toLowerCase() !== eoaAddr.toLowerCase()) {
      fetchPromises.push(ElacityAPI.fetchManagedChannels(saAddr));
    }
    Promise.all(fetchPromises).then(function (results) {
      var channels = [];
      var seen = {};
      results.forEach(function (result) {
        ((result && result.data) || []).forEach(function (ch) {
          var key = (ch.address || '').toLowerCase();
          if (!seen[key]) { seen[key] = true; channels.push(ch); }
        });
      });

      if (channels.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><p>You don\'t own any channels yet</p></div>';
        return;
      }

      var html = '';
      channels.forEach(function (ch) {
        var thumb = (ch.image || ch.thumbnail) ? u.resolveIpfsUrl(ch.image || ch.thumbnail) : '';
        html += '<div class="my-channel-card" data-address="' + u.escapeHtml(ch.address) + '">';
        html += '<div class="my-channel-header">';
        if (thumb) html += '<img class="my-channel-thumb" src="' + u.escapeHtml(thumb) + '" alt="" onerror="this.style.display=\'none\'" />';
        html += '<div class="my-channel-info">';
        html += '<div class="my-channel-name">' + u.escapeHtml(ch.name || 'Untitled Channel') + '</div>';
        html += '<div class="my-channel-meta">';
        html += '<span>' + (ch.itemsCount || 0) + ' assets</span>';
        html += '<span>' + (ch.subscribersCount || 0) + ' subscribers</span>';
        html += '<span>' + u.formatAddress(ch.address) + '</span>';
        html += '</div>';
        html += '</div>';
        html += '</div>';

        html += '<div class="my-channel-actions">';
        html += '<button class="action-btn my-ch-view" data-addr="' + u.escapeHtml(ch.address) + '">View</button>';
        html += '<button class="action-btn my-ch-edit" data-addr="' + u.escapeHtml(ch.address) + '">Edit Details</button>';
        html += '<button class="action-btn my-ch-plans" data-addr="' + u.escapeHtml(ch.address) + '">Manage Plans</button>';
        html += '</div>';
        html += '</div>';
      });

      listEl.innerHTML = html;

      listEl.querySelectorAll('.my-ch-view').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          M.openChannel(btn.dataset.addr);
        });
      });

      listEl.querySelectorAll('.my-ch-edit').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var addr = btn.dataset.addr;
          ElacityAPI.retrieveChannel(addr).then(function (channelData) {
            if (channelData) openEditChannelModal(channelData);
          }).catch(function (err) {
            u.showToast('Failed to load channel: ' + err.message, 'error');
          });
        });
      });

      listEl.querySelectorAll('.my-ch-plans').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var addr = btn.dataset.addr;
          ElacityAPI.retrieveChannel(addr).then(function (channelData) {
            if (channelData) openManagePlansModal(channelData);
          }).catch(function (err) {
            u.showToast('Failed to load channel: ' + err.message, 'error');
          });
        });
      });
    }).catch(function (err) {
      listEl.innerHTML = '<div class="empty-state"><p>Failed to load channels: ' + u.escapeHtml(err.message) + '</p></div>';
    });
  }

  function openManagePlansModal(channelData) {
    var existing = document.getElementById('manage-plans-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'manage-plans-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML =
      '<div class="modal-dialog" style="max-width:520px;">' +
        '<div class="modal-header"><h3>Manage Plans — ' + u.escapeHtml(channelData.name || '') + '</h3><button class="modal-close-btn" id="plans-modal-close">&times;</button></div>' +
        '<div class="modal-body">' +
          '<div id="plans-list"><div style="padding:16px 0;text-align:center;color:var(--text-tertiary);font-size:12px;">Loading plans from contract...</div></div>' +
          '<button id="plans-add-btn" class="btn-primary" style="margin-top:12px">+ Add Plan</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    document.getElementById('plans-modal-close').addEventListener('click', function () { modal.remove(); });
    document.getElementById('plans-add-btn').addEventListener('click', function () {
      modal.remove();
      openAddPlanModal(channelData);
    });

    // Fetch plans from on-chain contract (source of truth), fallback to local cache
    var plansPromise = (Wallet.getPlans ? Wallet.getPlans(channelData.address) : Promise.resolve([]));
    plansPromise.then(function (onChainPlans) {
      var plans = onChainPlans.length > 0 ? onChainPlans : (channelData.plans || []);

      // Merge label/description from local metadata (these aren't stored on-chain)
      var localPlans = channelData.plans || [];
      plans = plans.map(function (p) {
        var local = localPlans.find(function (lp) { return lp.planId === p.planId || lp.planId === String(p.planId); });
        return {
          planId: p.planId,
          payToken: p.payToken,
          price: p.price,
          duration: p.duration,
          durationSeconds: p.durationSeconds,
          active: p.active !== false,
          label: (local && local.label) || p.label || ('Plan #' + p.planId),
          description: (local && local.description) || p.description || ''
        };
      });

      channelData._onChainPlans = plans;

      var plansHtml = '';
      if (plans.length > 0) {
        plans.filter(function (p) { return p.active !== false; }).forEach(function (plan, idx) {
          var priceStr = typeof plan.price === 'number' ? plan.price.toFixed(2) : parseFloat(plan.price || 0).toFixed(2);
          var dur = plan.duration ? (plan.duration.value + ' ' + plan.duration.unit) : '—';
          var symbol = u.getTokenSymbol ? u.getTokenSymbol(plan.payToken) : 'USDC';
          plansHtml += '<div class="plan-modal-row" style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">';
          plansHtml += '<span style="flex:1;font-weight:500;">' + u.escapeHtml(plan.label) + '</span>';
          plansHtml += '<span style="font-size:12px;color:var(--text-secondary);">' + dur + '</span>';
          plansHtml += '<span style="font-weight:600;">' + priceStr + ' ' + symbol + '</span>';
          plansHtml += '<button class="earnings-withdraw-btn modal-edit-plan" data-idx="' + idx + '">Edit</button>';
          plansHtml += '<button class="earnings-withdraw-btn modal-remove-plan" data-idx="' + idx + '" style="background:#ef4444;">Remove</button>';
          plansHtml += '</div>';
        });
      } else {
        plansHtml = '<div style="padding:16px 0;text-align:center;color:var(--text-tertiary);font-size:12px;">No plans configured</div>';
      }

      document.getElementById('plans-list').innerHTML = plansHtml;

      modal.querySelectorAll('.modal-edit-plan').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var plan = plans[parseInt(btn.dataset.idx)];
          if (plan) { modal.remove(); openEditPlanModal(channelData, plan); }
        });
      });

      modal.querySelectorAll('.modal-remove-plan').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var idx = parseInt(btn.dataset.idx);
          var plan = plans[idx];
          if (!plan) return;
          btn.disabled = true;
          btn.textContent = '...';
          ElacityAPI.updateSubscriptionPlan(channelData.address, [{ action: 'REMOVE', args: { planId: plan.planId, label: plan.label } }], u.pc2Fetch)
            .then(function () {
              u.showToast('Plan removed!', 'success');
              btn.closest('.plan-modal-row').remove();
              plans.splice(idx, 1);
            })
            .catch(function (err) {
              btn.disabled = false;
              btn.textContent = 'Remove';
              u.showToast('Failed: ' + err.message, 'error');
            });
        });
      });
    });
  }

  // ── Channel Management ────────────────────────────

  function isChannelCreator(channelData) {
    if (!channelData || !Wallet.isConnected()) return false;
    var creatorAddr = (channelData.creator && channelData.creator.address) || '';
    if (!creatorAddr) return false;
    var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
    var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();
    return creatorAddr.toLowerCase() === eoaAddr || creatorAddr.toLowerCase() === saAddr;
  }

  function renderChannelManagement(channelData) {
    if (!isChannelCreator(channelData)) return;

    var existing = document.getElementById('channel-mgmt-btn');
    if (existing) return;

    var statsEl = document.querySelector('.channel-page-stats');
    if (!statsEl) return;

    var btns = [
      { label: 'Edit Channel', handler: function () { openEditChannelModal(channelData); } },
      { label: 'Manage Plans', handler: function () { openManagePlansModal(channelData); } },
      { label: 'Token Gating', handler: function () { openTokenGateModal(channelData, null); } }
    ];

    btns.forEach(function (cfg, i) {
      var btn = document.createElement('button');
      btn.className = 'channel-edit-btn';
      if (i === 0) btn.id = 'channel-mgmt-btn';
      btn.textContent = cfg.label;
      btn.addEventListener('click', cfg.handler);
      statsEl.appendChild(btn);
    });
  }

  function openEditChannelModal(channelData) {
    var existing = document.getElementById('edit-channel-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'edit-channel-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML =
      '<div class="modal-dialog" style="max-width:500px;">' +
        '<div class="modal-header">' +
          '<h3>Edit Channel</h3>' +
          '<button class="modal-close-btn" id="edit-channel-close">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<div class="form-group"><label>Name</label><input type="text" id="edit-ch-name" class="form-input" value="' + u.escapeHtml(channelData.name || '') + '" /></div>' +
          '<div class="form-group"><label>Description</label><textarea id="edit-ch-desc" class="form-input" rows="3">' + u.escapeHtml(channelData.description || '') + '</textarea></div>' +
          '<div class="form-group"><label>Categories (comma-separated)</label><input type="text" id="edit-ch-cats" class="form-input" value="' + u.escapeHtml((channelData.categories || []).join(', ')) + '" /></div>' +
          '<div class="form-group"><label>Channel Image</label>' +
            (channelData.image ? '<div id="edit-ch-image-preview" style="margin-bottom:8px;"><img src="' + u.resolveIpfsUrl(channelData.image, true) + '" onerror="this.src=\'' + u.resolveIpfsUrl(channelData.image) + '\'" style="max-width:120px;max-height:120px;border-radius:8px;object-fit:cover;" /></div>' : '<div id="edit-ch-image-preview" style="margin-bottom:8px;color:#888;font-size:12px;">No image set</div>') +
            '<input type="file" id="edit-ch-image-file" accept="image/*" class="form-input" style="padding:6px;" />' +
            '<input type="hidden" id="edit-ch-image" value="' + u.escapeHtml(channelData.image || '') + '" />' +
          '</div>' +
          '<div class="form-group"><label>Cover Image</label>' +
            (channelData.coverImage ? '<div id="edit-ch-cover-preview" style="margin-bottom:8px;"><img src="' + u.resolveIpfsUrl(channelData.coverImage, true) + '" onerror="this.src=\'' + u.resolveIpfsUrl(channelData.coverImage) + '\'" style="max-width:200px;max-height:80px;border-radius:8px;object-fit:cover;" /></div>' : '<div id="edit-ch-cover-preview" style="margin-bottom:8px;color:#888;font-size:12px;">No cover image set</div>') +
            '<input type="file" id="edit-ch-cover-file" accept="image/*" class="form-input" style="padding:6px;" />' +
            '<input type="hidden" id="edit-ch-cover" value="' + u.escapeHtml(channelData.coverImage || '') + '" />' +
          '</div>' +
          '<div id="edit-ch-status" class="modal-status hidden"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button id="edit-ch-cancel" class="btn-secondary">Cancel</button>' +
          '<button id="edit-ch-save" class="btn-primary">Save Changes</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    document.getElementById('edit-channel-close').addEventListener('click', function () { modal.remove(); });
    document.getElementById('edit-ch-cancel').addEventListener('click', function () { modal.remove(); });

    // Live preview for image file inputs
    document.getElementById('edit-ch-image-file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var preview = document.getElementById('edit-ch-image-preview');
      var reader = new FileReader();
      reader.onload = function () { preview.innerHTML = '<img src="' + reader.result + '" style="max-width:120px;max-height:120px;border-radius:8px;object-fit:cover;" />'; };
      reader.readAsDataURL(file);
    });
    document.getElementById('edit-ch-cover-file').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var preview = document.getElementById('edit-ch-cover-preview');
      var reader = new FileReader();
      reader.onload = function () { preview.innerHTML = '<img src="' + reader.result + '" style="max-width:200px;max-height:80px;border-radius:8px;object-fit:cover;" />'; };
      reader.readAsDataURL(file);
    });

    document.getElementById('edit-ch-save').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = 'Saving...';
      var statusEl = document.getElementById('edit-ch-status');
      statusEl.classList.add('hidden');

      var cats = document.getElementById('edit-ch-cats').value.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
      var imageFile = document.getElementById('edit-ch-image-file').files[0];
      var coverFile = document.getElementById('edit-ch-cover-file').files[0];

      var authReady = ElacityAPI.isAuthenticated() ? Promise.resolve() : Wallet.siweLogin();
      authReady.then(function () {
        var uploads = [];
        if (imageFile) {
          statusEl.textContent = 'Uploading image to IPFS...';
          statusEl.classList.remove('hidden');
          uploads.push(ElacityAPI.uploadToIpfs(imageFile, u.pc2Fetch).then(function (uri) { document.getElementById('edit-ch-image').value = uri; }));
        }
        if (coverFile) {
          statusEl.textContent = imageFile ? 'Uploading images to IPFS...' : 'Uploading cover to IPFS...';
          statusEl.classList.remove('hidden');
          uploads.push(ElacityAPI.uploadToIpfs(coverFile, u.pc2Fetch).then(function (uri) { document.getElementById('edit-ch-cover').value = uri; }));
        }

        return Promise.all(uploads);
      }).then(function () {
        var original = {
          name: channelData.name || '',
          description: channelData.description || '',
          categories: channelData.categories || [],
          image: channelData.image || '',
          coverImage: channelData.coverImage || ''
        };

        var formData = {
          name: document.getElementById('edit-ch-name').value,
          description: document.getElementById('edit-ch-desc').value,
          categories: cats,
          image: document.getElementById('edit-ch-image').value,
          coverImage: document.getElementById('edit-ch-cover').value
        };

        var input = {};
        Object.keys(original).forEach(function (key) {
          var origVal = original[key];
          var newVal = formData[key];
          if (Array.isArray(origVal)) {
            if (JSON.stringify(newVal) !== JSON.stringify(origVal)) input[key] = newVal;
          } else if (newVal !== origVal) {
            input[key] = newVal;
          }
        });

        if (Object.keys(input).length === 0) {
          btn.disabled = false;
          btn.textContent = 'Save Changes';
          u.showToast('No changes detected', 'info');
          return;
        }

        statusEl.textContent = 'Saving...';
        statusEl.classList.remove('hidden');
        console.log('[ChannelEdit] Saving changes to', channelData.address, 'input:', JSON.stringify(input), 'auth:', ElacityAPI.isAuthenticated());

        return ElacityAPI.updateChannelInformation(channelData.address, input, u.pc2Fetch).then(function () {
          u.showToast('Channel updated!', 'success');
          modal.remove();
          M.openChannel(channelData.address);
        });
      }).catch(function (err) {
        console.error('[ChannelEdit] Save failed:', err);
        btn.disabled = false;
        btn.textContent = 'Save Changes';
        statusEl.textContent = 'Failed: ' + err.message;
        statusEl.classList.remove('hidden');
      });
    });
  }

  // ── Subscription Plan Management ──────────────────

  function renderPlanManagement(channelData) {
    if (!isChannelCreator(channelData)) return;

    var plans = channelData.plans || [];
    if (plans.length === 0) return;

    var container = document.getElementById('channel-plans-mgmt');
    if (!container) {
      container = document.createElement('div');
      container.id = 'channel-plans-mgmt';
      container.style.cssText = 'margin-top:12px;';
      var contentTitle = document.querySelector('.channel-section-title');
      if (contentTitle) contentTitle.parentNode.insertBefore(container, contentTitle);
    }

    var html = '';
    plans.forEach(function (plan, idx) {
      html += '<div class="plan-card">';
      html += '<div class="plan-card-header"><span class="plan-name">' + u.escapeHtml(plan.label || 'Plan ' + (idx + 1)) + '</span>';
      html += '<span class="plan-price">' + u.formatPrice(plan.price, plan.payToken) + '</span></div>';
      if (plan.description) html += '<div class="plan-desc">' + u.escapeHtml(plan.description) + '</div>';
      if (plan.duration) html += '<div class="plan-duration">Duration: ' + plan.duration.value + ' ' + plan.duration.unit + '</div>';
      html += '</div>';
    });

    container.innerHTML = html;
  }

  function openEditPlanModal(channelData, plan) {
    var existing = document.getElementById('edit-plan-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'edit-plan-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML =
      '<div class="modal-dialog">' +
        '<div class="modal-header"><h3>Edit Plan: ' + u.escapeHtml(plan.label || '') + '</h3><button class="modal-close-btn" id="edit-plan-close">&times;</button></div>' +
        '<div class="modal-body">' +
          '<div class="form-group"><label>Description</label><input type="text" id="eplan-desc" class="form-input" value="' + u.escapeHtml(plan.description || '') + '" /></div>' +
          '<div class="form-group"><label>Duration Value</label><input type="number" id="eplan-dur-val" class="form-input" min="1" value="' + ((plan.duration && plan.duration.value) || 30) + '" /></div>' +
          '<div class="form-group"><label>Duration Unit</label><select id="eplan-dur-unit" class="form-input"><option value="days"' + ((plan.duration && plan.duration.unit === 'days') ? ' selected' : '') + '>Days</option><option value="months"' + ((plan.duration && plan.duration.unit === 'months') ? ' selected' : '') + '>Months</option><option value="years"' + ((plan.duration && plan.duration.unit === 'years') ? ' selected' : '') + '>Years</option></select></div>' +
          '<div class="form-group"><label>Price (USDC)</label><input type="number" id="eplan-price" class="form-input" min="0.01" step="0.01" value="' + (typeof plan.price === 'number' ? plan.price.toFixed(2) : parseFloat(plan.price || 0).toFixed(2)) + '" /></div>' +
          '<div id="edit-plan-status" class="modal-status hidden"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button id="eplan-cancel" class="btn-secondary">Cancel</button>' +
          '<button id="eplan-save" class="btn-primary">Save Changes</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    document.getElementById('edit-plan-close').addEventListener('click', function () { modal.remove(); });
    document.getElementById('eplan-cancel').addEventListener('click', function () { modal.remove(); });

    document.getElementById('eplan-save').addEventListener('click', function () {
      var btn = this;
      var price = parseFloat(document.getElementById('eplan-price').value);
      if (!price || price <= 0) { u.showToast('Enter a valid price', 'error'); return; }

      btn.disabled = true;
      btn.textContent = 'Saving...';

      ElacityAPI.updateSubscriptionPlan(channelData.address, [{
        action: 'UPDATE',
        args: {
          planId: plan.planId,
          label: plan.label,
          description: document.getElementById('eplan-desc').value,
          duration: { value: parseInt(document.getElementById('eplan-dur-val').value) || 30, unit: document.getElementById('eplan-dur-unit').value },
          price: String(price),
          payToken: plan.payToken || Wallet.USDC_ADDRESS
        }
      }], u.pc2Fetch).then(function () {
        u.showToast('Plan updated!', 'success');
        modal.remove();
        M.openChannel(channelData.address);
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Save Changes';
        u.showToast('Failed: ' + err.message, 'error');
      });
    });
  }

  function openAddPlanModal(channelData) {
    var existing = document.getElementById('add-plan-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'add-plan-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML =
      '<div class="modal-dialog">' +
        '<div class="modal-header"><h3>Add Subscription Plan</h3><button class="modal-close-btn" id="add-plan-close">&times;</button></div>' +
        '<div class="modal-body">' +
          '<div class="form-group"><label>Label</label><input type="text" id="plan-label" class="form-input" placeholder="e.g. Monthly Premium" /></div>' +
          '<div class="form-group"><label>Description</label><input type="text" id="plan-desc" class="form-input" placeholder="Plan description" /></div>' +
          '<div class="form-group"><label>Duration Value</label><input type="number" id="plan-dur-val" class="form-input" min="1" value="30" /></div>' +
          '<div class="form-group"><label>Duration Unit</label><select id="plan-dur-unit" class="form-input"><option value="days">Days</option><option value="months">Months</option><option value="years">Years</option></select></div>' +
          '<div class="form-group"><label>Price (USDC)</label><input type="number" id="plan-price" class="form-input" min="0.01" step="0.01" placeholder="e.g. 9.99" /></div>' +
          '<div id="add-plan-status" class="modal-status hidden"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button id="add-plan-cancel" class="btn-secondary">Cancel</button>' +
          '<button id="add-plan-confirm" class="btn-primary">Add Plan</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    document.getElementById('add-plan-close').addEventListener('click', function () { modal.remove(); });
    document.getElementById('add-plan-cancel').addEventListener('click', function () { modal.remove(); });

    document.getElementById('add-plan-confirm').addEventListener('click', function () {
      var btn = this;
      var label = document.getElementById('plan-label').value;
      var desc = document.getElementById('plan-desc').value;
      var durVal = parseInt(document.getElementById('plan-dur-val').value) || 30;
      var durUnit = document.getElementById('plan-dur-unit').value;
      var price = parseFloat(document.getElementById('plan-price').value);

      if (!label) { u.showToast('Label is required', 'error'); return; }
      if (!price || price <= 0) { u.showToast('Enter a valid price', 'error'); return; }

      btn.disabled = true;
      btn.textContent = 'Adding...';

      ElacityAPI.updateSubscriptionPlan(channelData.address, [{
        action: 'ADD',
        args: {
          label: label,
          description: desc,
          duration: { value: durVal, unit: durUnit },
          price: String(price),
          payToken: Wallet.USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
        }
      }], u.pc2Fetch).then(function () {
        u.showToast('Plan added!', 'success');
        modal.remove();
        M.openChannel(channelData.address);
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Add Plan';
        u.showToast('Failed: ' + err.message, 'error');
      });
    });
  }

  // ── Token-Gating Display + Configuration ──────────

  function renderTokenGating(channelData) {
    if (!channelData) return;

    var tokenAccess = channelData.tokenAccess || [];
    var container = document.getElementById('channel-token-gate');
    if (!container) {
      container = document.createElement('div');
      container.id = 'channel-token-gate';
      container.className = 'token-gate-section';
      var desc = document.getElementById('channel-description');
      if (desc) desc.parentNode.insertBefore(container, desc.nextSibling);
    }

    var isCreator = isChannelCreator(channelData);

    if (tokenAccess.length === 0) {
      if (container) container.remove();
      return;
    }

    function renderGateUI(accessResult) {
      var hasAccess = accessResult && accessResult.haveAccess;
      var html = '';

      html += '<div class="gate-status ' + (hasAccess ? 'granted' : 'denied') + '">' +
        (hasAccess ? '&#10003; Access Granted' : '&#128274; Token-Gated Content') +
      '</div>';
      html += '<div class="gate-requirements">';
      tokenAccess.forEach(function (req) {
        html += '<div class="gate-req-row" style="display:flex;align-items:center;gap:8px;">';
        html += '<span style="flex:1;">Token: ' + u.formatAddress(req.address) + '</span>';
        html += '<span>Min: ' + (req.value || '1') + '</span>';
        html += '</div>';
      });
      html += '</div>';

      container.innerHTML = html;
    }

    if (!Wallet.isConnected()) {
      if (tokenAccess.length === 0) return;
      container.innerHTML =
        '<div class="gate-status denied">&#128274; VIP Token-Gated Content</div>' +
        '<div class="gate-requirements">' +
          tokenAccess.map(function (req) {
            return '<div class="gate-req-row">Requires: ' + u.formatAddress(req.address) + ' (min: ' + (req.value || '1') + ')</div>';
          }).join('') +
        '</div>';
      return;
    }

    ElacityAPI.checkChannelAccess(channelData.address, Wallet.getSignerAddress() || Wallet.getAddress())
      .then(function (access) { renderGateUI(access); })
      .catch(function () { renderGateUI(null); });
  }

  function openTokenGateModal(channelData, existingRule) {
    var existing = document.getElementById('token-gate-modal');
    if (existing) existing.remove();

    var isEdit = !!existingRule;
    var title = isEdit ? 'Edit Token Gate' : 'Add Token Gate';

    var modal = document.createElement('div');
    modal.id = 'token-gate-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML =
      '<div class="modal-dialog">' +
        '<div class="modal-header"><h3>' + title + '</h3><button class="modal-close-btn" id="gate-modal-close">&times;</button></div>' +
        '<div class="modal-body">' +
          '<div class="form-group"><label>Token Contract Address</label><input type="text" id="gate-token-addr" class="form-input" placeholder="0x..." value="' + u.escapeHtml((existingRule && existingRule.address) || '') + '"' + (isEdit ? ' readonly style="opacity:0.6;"' : '') + ' /></div>' +
          '<div id="gate-token-info" style="font-size:11px;color:var(--text-tertiary);margin-bottom:8px;"></div>' +
          '<div class="form-group"><label>Minimum Balance Required</label><input type="number" id="gate-min-bal" class="form-input" min="1" step="1" value="' + u.escapeHtml((existingRule && existingRule.value) || '1') + '" /></div>' +
          '<div id="gate-status" class="modal-status hidden"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button id="gate-cancel" class="btn-secondary">Cancel</button>' +
          '<button id="gate-save" class="btn-primary">Save</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    document.getElementById('gate-modal-close').addEventListener('click', function () { modal.remove(); });
    document.getElementById('gate-cancel').addEventListener('click', function () { modal.remove(); });

    var gateTokenInfo = null;
    var addrInput = document.getElementById('gate-token-addr');
    if (!isEdit) {
      addrInput.addEventListener('blur', function () {
        var addr = addrInput.value.trim();
        var infoEl = document.getElementById('gate-token-info');
        gateTokenInfo = null;
        if (!addr || !ethers.isAddress(addr)) {
          infoEl.textContent = addr ? 'Invalid address' : '';
          infoEl.style.color = '#ef4444';
          return;
        }
        infoEl.textContent = 'Detecting token type...';
        infoEl.style.color = 'var(--text-tertiary)';
        Wallet.introspectToken(addr).then(function (info) {
          if (info && info.valid) {
            gateTokenInfo = info;
            var label = info.isERC721 ? 'ERC-721 NFT' : ('ERC-20 (' + info.decimals + ' decimals)');
            infoEl.textContent = (info.name || '') + (info.symbol ? ' (' + info.symbol + ')' : '') + ' — ' + label;
            infoEl.style.color = '#22c55e';
            var balLabel = document.querySelector('label[for="gate-min-bal"]') || document.getElementById('gate-min-bal').previousElementSibling;
            if (balLabel) {
              balLabel.textContent = info.isERC721 ? 'Minimum NFTs Required' : 'Minimum Token Balance Required';
            }
          } else {
            infoEl.textContent = 'Could not verify token — proceed with caution';
            infoEl.style.color = '#f59e0b';
          }
        });
      });
    } else if (existingRule) {
      gateTokenInfo = { valid: true, decimals: existingRule.decimals || 0, isERC721: (existingRule.decimals === 0) };
    }

    document.getElementById('gate-save').addEventListener('click', function () {
      var btn = this;
      var addr = document.getElementById('gate-token-addr').value.trim();
      var minBal = document.getElementById('gate-min-bal').value;

      if (!addr || !ethers.isAddress(addr)) {
        u.showToast('Enter a valid token address', 'error');
        return;
      }
      if (!minBal || parseFloat(minBal) < (gateTokenInfo && gateTokenInfo.isERC721 ? 1 : 0.000001)) {
        u.showToast('Minimum balance must be at least 1', 'error');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Saving...';

      var tokenAccess = channelData.tokenAccess || [];
      var newThresholds = tokenAccess
        .filter(function (t) { return t.address.toLowerCase() !== addr.toLowerCase(); })
        .map(function (t) { return { address: t.address, value: parseFloat(t.value) || 1, decimals: t.decimals }; });
      newThresholds.push({
        address: addr,
        value: parseFloat(minBal) || 1,
        decimals: gateTokenInfo ? gateTokenInfo.decimals : 0
      });

      saveTokenGateConfig(channelData.address, newThresholds);
      modal.remove();
    });
  }

  function validateTokenContract(addr) {
    var iface = new ethers.Interface(['function name() view returns (string)', 'function symbol() view returns (string)']);
    var nameData = iface.encodeFunctionData('name', []);
    return window.ethereum.request({
      method: 'eth_call',
      params: [{ to: addr, data: nameData }, 'latest']
    }).then(function (result) {
      try {
        var decoded = ethers.AbiCoder.defaultAbiCoder().decode(['string'], result);
        return decoded[0] || 'ERC20/ERC721';
      } catch (e) { return 'Token contract'; }
    }).catch(function () { return null; });
  }

  function saveTokenGateConfig(channelAddress, thresholds) {
    ElacityAPI.updateChannelInformation(channelAddress, {
      tokenAccess: thresholds
    }).then(function () {
      u.showToast('Token gate config saved!', 'success');
      M.openChannel(channelAddress);
    }).catch(function (err) {
      u.showToast('Failed: ' + err.message, 'error');
    });
  }

  // ── Subscription Lifecycle ────────────────────────

  function renderSubscriptionStatus(channelData) {
    if (!channelData || !Wallet.isConnected()) return;

    var addr = Wallet.getSignerAddress() || Wallet.getAddress();

    ElacityAPI.checkChannelAccess(channelData.address, addr)
      .then(function (access) {
        if (!access) return;

        var container = document.getElementById('channel-sub-status');
        if (!container) {
          container = document.createElement('div');
          container.id = 'channel-sub-status';
          var subscribeBtn = document.getElementById('subscribe-btn');
          if (subscribeBtn) subscribeBtn.parentNode.insertBefore(container, subscribeBtn.nextSibling);
        }

        if (access.model === 'AccessModelSubscription' && access.expiresAt) {
          var expiryDate = new Date(access.expiresAt);
          var now = new Date();
          var daysLeft = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

          var statusClass = daysLeft <= 0 ? 'expired' : daysLeft <= 7 ? 'warning' : 'active';
          var statusText = daysLeft <= 0 ? 'Subscription expired' :
                           daysLeft <= 7 ? 'Expires in ' + daysLeft + ' days' :
                           'Active until ' + expiryDate.toLocaleDateString();

          container.innerHTML =
            '<div class="sub-expiry ' + statusClass + '">' +
              '<span>' + statusText + '</span>' +
              (daysLeft <= 0 ? '<button id="renew-sub-btn" class="btn-primary" style="padding:4px 12px;font-size:11px;margin-left:8px;min-height:auto;border-radius:4px">Renew</button>' : '') +
            '</div>' +
            (access.hasAccess && daysLeft > 0 ?
              '<button id="unsub-btn" class="btn-secondary" style="margin-top:6px;padding:6px 14px;font-size:12px">Unsubscribe</button>' : '');

          var renewBtn = document.getElementById('renew-sub-btn');
          if (renewBtn) {
            renewBtn.addEventListener('click', function () {
              var subscribeBtn = document.getElementById('subscribe-btn');
              if (subscribeBtn) subscribeBtn.click();
            });
          }

          var unsubBtn = document.getElementById('unsub-btn');
          if (unsubBtn) {
            unsubBtn.addEventListener('click', function () {
              if (!confirm('Are you sure you want to unsubscribe?')) return;
              unsubBtn.disabled = true;
              unsubBtn.textContent = '...';
              ElacityAPI.unsubscribeChannel(channelData.address)
                .then(function () {
                  u.showToast('Unsubscribed', 'success');
                  unsubBtn.textContent = 'Unsubscribed';
                  var subscribeBtn = document.getElementById('subscribe-btn');
                  if (subscribeBtn) {
                    subscribeBtn.textContent = 'Subscribe';
                    subscribeBtn.classList.remove('subscribed');
                  }
                })
                .catch(function (err) {
                  unsubBtn.disabled = false;
                  unsubBtn.textContent = 'Unsubscribe';
                  u.showToast('Failed: ' + err.message, 'error');
                });
            });
          }
        }
      })
      .catch(function () {});
  }

  // ── Hook into channel rendering via custom event ───

  window.addEventListener('ela-channel-rendered', function (e) {
    var channelData = e.detail && e.detail.channel;
    if (!channelData) return;
    renderChannelManagement(channelData);
    renderPlanManagement(channelData);
    renderTokenGating(channelData);
    renderSubscriptionStatus(channelData);
  });

  // ── Expose functions for app.js to call ───────────
  window.ElaMarket.openEditChannelModal = openEditChannelModal;
  window.ElaMarket.openManagePlansModal = openManagePlansModal;
  window.ElaMarket.openResellAccessModal = function (contractAddr, ledger, hexTokenId) {
    openResellAccessModal(contractAddr, ledger, hexTokenId);
  };
  window.ElaMarket.openListRoyaltySharesModal = function (contractAddr) {
    openListSharesModal(contractAddr, 'eoa', 0);
  };
  window.ElaMarket.openTransferSharesModal = function (contractAddr) {
    openTransferSharesModal(contractAddr, 'eoa', 0);
  };
  window.ElaMarket.renderOrderBook = renderOrderBook;
  window.ElaMarket.loadEarningsOffers = loadEarningsOffers;
  window.ElaMarket.renderVendorsSection = renderVendorsSection;

  // ── Hook into earnings view ───────────────────────

  var _origLoadEarningsView = M.loadEarningsView;
  window.ElaMarket.loadEarningsView = function () {
    _origLoadEarningsView();
    setTimeout(function () {
      setupExtraTabs();
    }, 300);
    retryEnhance(0);
  };

  // ── Init: set up badge and hook wallet connect ────

  function initFeatures() {
    var origUpdateWalletUI = window.ElaMarket._updateWalletUI;

    window.addEventListener('wallet-connected', function () {
      updateEarningsBadge();
    });

    setTimeout(function () {
      if (Wallet.isConnected()) {
        updateEarningsBadge();
      }
    }, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFeatures);
  } else {
    initFeatures();
  }
})();
