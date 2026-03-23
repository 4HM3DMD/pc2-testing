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
      ElacityAPI.fetchRewardSummary(eoaAddr, 'Assets').catch(function () { return []; }),
      ElacityAPI.fetchRewardSummary(eoaAddr, 'Channels').catch(function () { return []; }),
      ElacityAPI.searchOfferEvents(null, null, 50).catch(function () { return []; }),
      ElacityAPI.searchIncomingOfferEvents(null, null, 50).catch(function () { return []; })
    ];
    if (hasSA) {
      fetches.push(ElacityAPI.fetchRewardSummary(saAddr, 'Assets').catch(function () { return []; }));
      fetches.push(ElacityAPI.fetchRewardSummary(saAddr, 'Channels').catch(function () { return []; }));
    }

    Promise.all(fetches).then(function (results) {
      var assetRewards = results[0] || [];
      var channelRewards = results[1] || [];
      var outOffers = results[2] || [];
      var inOffers = results[3] || [];

      if (hasSA) {
        assetRewards = assetRewards.concat(results[4] || []);
        channelRewards = channelRewards.concat(results[5] || []);
      }

      var assetCount = 0; var seenA = {};
      assetRewards.forEach(function (r) { if (!seenA[r.address] && r.unclaimedRewards > 0) { seenA[r.address] = true; assetCount++; } });

      var channelCount = 0; var seenC = {};
      channelRewards.forEach(function (r) { if (!seenC[r.address] && r.unclaimedRewards > 0) { seenC[r.address] = true; channelCount++; } });

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
      var govSection = document.getElementById('detail-governance-section');
      if (govSection) govSection.parentNode.insertBefore(container, govSection.nextSibling);
      else {
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
      expandIcon.innerHTML = '&#9662;';
      item.querySelector('.earnings-item-info').appendChild(expandIcon);

      var panel = document.createElement('div');
      panel.className = 'earnings-expanded-panel';
      panel.innerHTML = '<div class="loading-indicator"><div class="spinner"></div><span>Loading stats...</span></div>';
      item.appendChild(panel);

      var itemType = item.dataset.itemtype || 'asset';

      item.addEventListener('click', function (e) {
        if (e.target.closest('.earnings-withdraw-btn')) return;
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

    if (!isChannel && contractAddr) {
      fetches.push(Wallet.getAccessTokenBalance(contractAddr, eoaAddr).catch(function () { return 0; }));
      fetches.push(saAddr && saAddr.toLowerCase() !== eoaAddr.toLowerCase()
        ? Wallet.getAccessTokenBalance(contractAddr, saAddr).catch(function () { return 0; })
        : Promise.resolve(0));
      fetches.push(Wallet.getPendingRewards(contractAddr, account, Wallet.USDC_ADDRESS).catch(function () { return '0'; }));
      fetches.push(Wallet.getPendingRewards(contractAddr, account, '0x0000000000000000000000000000000000000000').catch(function () { return '0'; }));
    } else {
      fetches.push(Promise.resolve(0), Promise.resolve(0), Promise.resolve('0'), Promise.resolve('0'));
    }

    if (isChannel) {
      fetches.push(ElacityAPI.listSubscribers(contractAddr).catch(function () { return { count: 0 }; }));
      fetches.push(ElacityAPI.retrieveChannel(contractAddr).catch(function () { return null; }));
    } else {
      fetches.push(Promise.resolve(null), Promise.resolve(null));
    }

    Promise.all(fetches).then(function (results) {
      var stat = results[0];
      var gov = results[1];
      var eoaAccessBal = results[2] || 0;
      var saAccessBal = results[3] || 0;
      var usdcRewards = results[4] || '0';
      var ethRewards = results[5] || '0';
      var subInfo = results[6];
      var channelInfo = results[7];
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

      if (!isChannel) {
        html += '<div class="stat-card"><div class="stat-card-label">My Access (EOA)</div><div class="stat-card-value">' + eoaAccessBal + '</div></div>';
        if (saAddr && saAddr.toLowerCase() !== eoaAddr.toLowerCase()) {
          html += '<div class="stat-card"><div class="stat-card-label">My Access (SA)</div><div class="stat-card-value">' + saAccessBal + '</div></div>';
        }
      }

      if (gov) {
        if (gov.governance) {
          var avail = gov.governance.available || 0;
          var owned = gov.governance.owned || 0;
          var govVol = gov.governance.volumeUSD || 0;
          var yourPct = avail > 0 ? ((owned / 10).toFixed(1)) : '0';
          var availPct = avail > 0 ? ((avail / 10).toFixed(1)) : '0';
          html += '<div class="stat-card"><div class="stat-card-label">Your Royalty</div><div class="stat-card-value">' + yourPct + '%</div></div>';
          html += '<div class="stat-card"><div class="stat-card-label">Available Royalty</div><div class="stat-card-value">' + availPct + '%</div></div>';
          html += '<div class="stat-card"><div class="stat-card-label">Gov. Volume</div><div class="stat-card-value">$' + govVol.toFixed(2) + '</div></div>';
        }
        if (gov.floor !== undefined && gov.floor !== null) {
          html += '<div class="stat-card"><div class="stat-card-label">Floor (Royalty)</div><div class="stat-card-value">' + u.formatPrice(gov.floor) + '</div></div>';
        }
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
          html += '<button class="earnings-withdraw-btn" data-action="withdraw" data-contract="' + u.escapeHtml(contractAddr) + '" data-paytoken="' + Wallet.USDC_ADDRESS + '">Withdraw</button>';
          html += '</div>';
        }
        if (hasEth) {
          html += '<div class="withdraw-token-row" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">';
          html += '<span style="font-size:12px;">ETH: <strong>' + ethVal.toFixed(6) + '</strong></span>';
          html += '<button class="earnings-withdraw-btn" data-action="withdraw" data-contract="' + u.escapeHtml(contractAddr) + '" data-paytoken="0x0000000000000000000000000000000000000000">Withdraw</button>';
          html += '</div>';
        }
        if (hasUsdc && hasEth) {
          html += '<button class="earnings-withdraw-btn" data-action="withdraw-all" data-contract="' + u.escapeHtml(contractAddr) + '" style="margin-top:4px;background:var(--accent);">Withdraw All</button>';
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

      html += '<div class="expanded-actions">';
      if (ledger && tokenId) {
        html += '<button class="action-btn" onclick="ElaMarket.openDetail(\'' + u.escapeHtml(contractAddr) + '\', \'' + u.escapeHtml(tokenId) + '\')"><span>View Asset</span></button>';
      }
      html += '</div>';

      panel.innerHTML = html;

      panel.querySelectorAll('[data-action="withdraw"]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var contract = btn.dataset.contract;
          var paytoken = btn.dataset.paytoken;
          btn.disabled = true;
          btn.textContent = '...';
          Wallet.withdrawRewards(contract, paytoken).then(function () {
            u.showToast('Withdrawal submitted!', 'success');
            btn.textContent = 'Done';
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
          btn.disabled = true;
          btn.textContent = '...';
          var tokens = [Wallet.USDC_ADDRESS, '0x0000000000000000000000000000000000000000'];
          Wallet.batchWithdrawRewards(contract, tokens).then(function () {
            u.showToast('All rewards withdrawn!', 'success');
            btn.textContent = 'Done';
          }).catch(function (err) {
            btn.disabled = false;
            btn.textContent = 'Withdraw All';
            if (err.message && err.message.indexOf('rejected') === -1) {
              u.showToast('Failed: ' + u.decodeContractError(err.message), 'error');
            }
          });
        });
      });
    });
  }

  // ── Make Offer UI ─────────────────────────────────

  function renderOfferSection(nft) {
    var operative = nft.operative || {};
    var operativeAddr = operative.address || '';
    if (!operativeAddr || !Wallet.isConnected()) return;

    var eoaAddr = Wallet.getAddress() || '';
    var saAddr = Wallet.getSmartAccountAddress() || '';

    Wallet.getRoyaltyShareBalance(operativeAddr, eoaAddr).then(function (bal) {
      var hasBal = parseInt(bal) > 0;
      if (hasBal) return;

      var offerContainer = document.getElementById('detail-offer-section');
      if (!offerContainer) {
        offerContainer = document.createElement('div');
        offerContainer.id = 'detail-offer-section';
        offerContainer.className = 'offer-section';
        var govSection = document.getElementById('detail-governance-section');
        if (govSection) govSection.parentNode.insertBefore(offerContainer, govSection.nextSibling);
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
          '<div class="form-group">' +
            '<label for="offer-quantity">Quantity (10 tokens = 1%)</label>' +
            '<input type="number" id="offer-quantity" min="1" step="1" placeholder="e.g. 10" class="form-input" />' +
          '</div>' +
          '<div class="form-group">' +
            '<label for="offer-price">Price per token (USDC)</label>' +
            '<input type="number" id="offer-price" min="0.01" step="0.01" placeholder="e.g. 5.00" class="form-input" />' +
          '</div>' +
          '<div id="offer-status" class="modal-status hidden"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button id="offer-cancel-btn" class="btn-secondary">Cancel</button>' +
          '<button id="offer-confirm-btn" class="btn-primary">Submit Offer</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    document.getElementById('offer-modal-close').addEventListener('click', function () { modal.remove(); });
    document.getElementById('offer-cancel-btn').addEventListener('click', function () { modal.remove(); });

    document.getElementById('offer-confirm-btn').addEventListener('click', function () {
      var qty = parseInt(document.getElementById('offer-quantity').value);
      var priceUsd = parseFloat(document.getElementById('offer-price').value);
      if (!qty || qty <= 0) { u.showToast('Enter a valid quantity', 'error'); return; }
      if (!priceUsd || priceUsd <= 0) { u.showToast('Enter a valid price', 'error'); return; }

      var pricePerToken = BigInt(Math.round(priceUsd * 1e6));
      var btn = document.getElementById('offer-confirm-btn');
      var statusEl = document.getElementById('offer-status');

      btn.disabled = true;
      btn.textContent = 'Approving USDC...';
      statusEl.textContent = 'Sending approval...';
      statusEl.classList.remove('hidden');

      Wallet.createRoyaltyOffer(operativeAddr, qty, pricePerToken.toString(), Wallet.USDC_ADDRESS)
        .then(function () {
          u.showToast('Offer submitted!', 'success');
          modal.remove();
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Submit Offer';
          if (err.message && err.message.indexOf('rejected') === -1) {
            statusEl.textContent = 'Failed: ' + u.decodeContractError(err.message);
          } else {
            statusEl.classList.add('hidden');
          }
        });
    });
  }

  // ── Offers Tab in Earnings ────────────────────────

  function loadEarningsOffers() {
    var listEl = document.getElementById('earnings-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="loading-indicator"><div class="spinner"></div><span>Loading offers...</span></div>';

    var eoaAddr = Wallet.getAddress();
    var saAddr = Wallet.getSmartAccountAddress();

    Promise.all([
      ElacityAPI.searchOfferEvents(null, null, 50).catch(function () { return []; }),
      ElacityAPI.searchIncomingOfferEvents(null, null, 50).catch(function () { return []; })
    ]).then(function (results) {
      var outgoing = results[0] || [];
      var incoming = results[1] || [];

      if (outgoing.length === 0 && incoming.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><p>No offers found</p></div>';
        return;
      }

      var html = '';

      if (outgoing.length > 0) {
        html += '<div style="font-size:12px;font-weight:600;color:var(--text-secondary);padding:8px 0;">Outgoing Offers</div>';
        outgoing.forEach(function (evt) {
          var tokenName = (evt.token && evt.token.name) || 'Unknown';
          var price = evt.price ? u.formatPrice(evt.price, evt.paymentToken) : '';
          html += '<div class="offer-row">';
          html += '<span style="flex:1;font-weight:500;">' + u.escapeHtml(tokenName) + '</span>';
          html += '<span>x' + (evt.quantity || 1) + '</span>';
          if (price) html += '<span style="font-weight:600;">' + price + '</span>';
          html += '<span style="font-size:11px;color:var(--text-tertiary);">' + (evt.createdAt ? new Date(evt.createdAt).toLocaleDateString() : '') + '</span>';
          if (evt.token && evt.token.address) {
            html += '<button class="earnings-withdraw-btn" data-action="cancel-offer" data-contract="' + u.escapeHtml(evt.token.address) + '">Cancel</button>';
          }
          html += '</div>';
        });
      }

      if (incoming.length > 0) {
        html += '<div style="font-size:12px;font-weight:600;color:var(--text-secondary);padding:8px 0;margin-top:8px;">Incoming Offers</div>';
        incoming.forEach(function (evt) {
          var tokenName = (evt.token && evt.token.name) || 'Unknown';
          var price = evt.price ? u.formatPrice(evt.price, evt.paymentToken) : '';
          var fromAddr = (evt.from && evt.from.address) || '';
          html += '<div class="offer-row">';
          html += '<span style="flex:1;font-weight:500;">' + u.escapeHtml(tokenName) + '</span>';
          html += '<span style="font-size:11px;">from ' + u.formatAddress(fromAddr) + '</span>';
          html += '<span>x' + (evt.quantity || 1) + '</span>';
          if (price) html += '<span style="font-weight:600;">' + price + '</span>';
          if (evt.token && evt.token.address && fromAddr) {
            html += '<button class="earnings-withdraw-btn" data-action="accept-offer" data-contract="' + u.escapeHtml(evt.token.address) + '" data-from="' + u.escapeHtml(fromAddr) + '" data-qty="' + (evt.quantity || 1) + '" style="background:var(--success);">Accept</button>';
          }
          html += '</div>';
        });
      }

      listEl.innerHTML = html;

      listEl.querySelectorAll('[data-action="cancel-offer"]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var addr = btn.dataset.contract;
          btn.disabled = true;
          btn.textContent = '...';
          Wallet.cancelRoyaltyOffer(addr).then(function () {
            u.showToast('Offer cancelled', 'success');
            btn.parentNode.remove();
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
          btn.textContent = '...';
          Wallet.acceptRoyaltyOffer(from, addr, qty).then(function () {
            u.showToast('Offer accepted!', 'success');
            btn.parentNode.remove();
          }).catch(function (err) {
            btn.disabled = false;
            btn.textContent = 'Accept';
            if (err.message && err.message.indexOf('rejected') === -1) {
              u.showToast('Failed: ' + u.decodeContractError(err.message), 'error');
            }
          });
        });
      });
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

  // ── Hook into detail rendering via custom event ────

  window.addEventListener('ela-detail-rendered', function (e) {
    var nft = e.detail && e.detail.nft;
    if (!nft) return;
    renderActivitySection(nft);
    renderPublishToggle(nft);
    renderOfferSection(nft);
    renderDistributionRights(nft);
  });

  // ── Hook into earnings rendering ──────────────────

  var _origLoadEarningsData = M.loadEarningsData;
  if (_origLoadEarningsData) {
    window.ElaMarket.loadEarningsData = function (category) {
      _origLoadEarningsData(category);
      setTimeout(enhanceEarningsItems, 800);
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

    // My Channels tab
    var myChTab = document.createElement('button');
    myChTab.className = 'earnings-tab';
    myChTab.dataset.tab = 'mychannels';
    myChTab.textContent = 'My Channels';
    tabsEl.appendChild(myChTab);

    myChTab.addEventListener('click', function (e) {
      e.stopPropagation();
      tabsEl.querySelectorAll('.earnings-tab').forEach(function (t) { t.classList.remove('active'); });
      myChTab.classList.add('active');
      state.earningsTab = 'mychannels';
      loadMyChannels();
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

    var creatorAddr = ElacityAPI.getSignerAddress() || Wallet.getSmartAccountAddress() || Wallet.getAddress() || '';
    ElacityAPI.fetchManagedChannels(creatorAddr, { offset: 0, limit: 100, sort: { itemsCount: -1 } }).then(function (result) {
      var channels = (result && result.data) || [];

      if (channels.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><p>You don\'t own any channels yet</p></div>';
        return;
      }

      var html = '';
      channels.forEach(function (ch) {
        var thumb = ch.image ? u.resolveIpfsUrl(ch.image) : '';
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
    var plans = channelData.plans || [];
    var existing = document.getElementById('manage-plans-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'manage-plans-modal';
    modal.className = 'modal-overlay';

    var plansHtml = '';
    if (plans.length > 0) {
      plans.forEach(function (plan, idx) {
        var priceUsd = ((plan.price || 0) / 1e6).toFixed(2);
        var dur = plan.duration ? (plan.duration.value + ' ' + plan.duration.unit) : '—';
        plansHtml += '<div class="plan-modal-row" style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">';
        plansHtml += '<span style="flex:1;font-weight:500;">' + u.escapeHtml(plan.label || 'Plan ' + (idx + 1)) + '</span>';
        plansHtml += '<span style="font-size:12px;color:var(--text-secondary);">' + dur + '</span>';
        plansHtml += '<span style="font-weight:600;">$' + priceUsd + '</span>';
        plansHtml += '<button class="earnings-withdraw-btn modal-edit-plan" data-idx="' + idx + '">Edit</button>';
        plansHtml += '<button class="earnings-withdraw-btn modal-remove-plan" data-idx="' + idx + '" style="background:#ef4444;">Remove</button>';
        plansHtml += '</div>';
      });
    } else {
      plansHtml = '<div style="padding:16px 0;text-align:center;color:var(--text-tertiary);font-size:12px;">No plans configured</div>';
    }

    modal.innerHTML =
      '<div class="modal-dialog" style="max-width:520px;">' +
        '<div class="modal-header"><h3>Manage Plans — ' + u.escapeHtml(channelData.name || '') + '</h3><button class="modal-close-btn" id="plans-modal-close">&times;</button></div>' +
        '<div class="modal-body">' +
          '<div id="plans-list">' + plansHtml + '</div>' +
          '<button id="plans-add-btn" class="btn-primary" style="margin-top:12px">+ Add Plan</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    document.getElementById('plans-modal-close').addEventListener('click', function () { modal.remove(); });

    document.getElementById('plans-add-btn').addEventListener('click', function () {
      modal.remove();
      openAddPlanModal(channelData);
    });

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
        ElacityAPI.updateSubscriptionPlan(channelData.address, [{ action: 'REMOVE', args: { planId: plan.planId, label: plan.label } }])
          .then(function () {
            u.showToast('Plan removed', 'success');
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
  }

  // ── Channel Management ────────────────────────────

  function renderChannelManagement(channelData) {
    if (!channelData || !Wallet.isConnected()) return;

    var creatorAddr = (channelData.creator && channelData.creator.address) || '';
    var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
    var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();
    var isCreator = creatorAddr && (creatorAddr.toLowerCase() === eoaAddr || creatorAddr.toLowerCase() === saAddr);

    if (!isCreator) return;

    var existing = document.getElementById('channel-mgmt-btn');
    if (existing) return;

    var profileInfo = document.querySelector('.channel-profile-info');
    if (!profileInfo) return;

    var editBtn = document.createElement('button');
    editBtn.id = 'channel-mgmt-btn';
    editBtn.className = 'channel-edit-btn';
    editBtn.textContent = 'Edit Channel';
    profileInfo.appendChild(editBtn);

    editBtn.addEventListener('click', function () {
      openEditChannelModal(channelData);
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
          '<div class="form-group"><label>Image URL</label><input type="text" id="edit-ch-image" class="form-input" value="' + u.escapeHtml(channelData.image || '') + '" /></div>' +
          '<div class="form-group"><label>Cover Image URL</label><input type="text" id="edit-ch-cover" class="form-input" value="' + u.escapeHtml(channelData.coverImage || '') + '" /></div>' +
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

    document.getElementById('edit-ch-save').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = 'Saving...';

      var cats = document.getElementById('edit-ch-cats').value.split(',').map(function (c) { return c.trim(); }).filter(Boolean);

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

      console.log('[ChannelEdit] Saving changes to', channelData.address, 'input:', JSON.stringify(input), 'auth:', ElacityAPI.isAuthenticated());

      var doSave = function () {
        return ElacityAPI.updateChannelInformation(channelData.address, input).then(function () {
          u.showToast('Channel updated!', 'success');
          modal.remove();
          M.openChannel(channelData.address);
        });
      };

      var savePromise = ElacityAPI.isAuthenticated() ? doSave() : Wallet.siweLogin().then(doSave);
      savePromise.catch(function (err) {
        console.error('[ChannelEdit] Save failed:', err);
        btn.disabled = false;
        btn.textContent = 'Save Changes';
        var statusEl = document.getElementById('edit-ch-status');
        statusEl.textContent = 'Failed: ' + err.message;
        statusEl.classList.remove('hidden');
      });
    });
  }

  // ── Subscription Plan Management ──────────────────

  function renderPlanManagement(channelData) {
    if (!channelData || !Wallet.isConnected()) return;

    var creatorAddr = (channelData.creator && channelData.creator.address) || '';
    var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
    var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();
    var isCreator = creatorAddr && (creatorAddr.toLowerCase() === eoaAddr || creatorAddr.toLowerCase() === saAddr);
    if (!isCreator) return;

    var container = document.getElementById('channel-plans-mgmt');
    if (!container) {
      container = document.createElement('div');
      container.id = 'channel-plans-mgmt';
      container.style.cssText = 'margin-top:16px;';
      var contentGrid = document.getElementById('channel-items-grid');
      if (contentGrid) contentGrid.parentNode.insertBefore(container, contentGrid);
    }

    var plans = channelData.plans || [];
    var html = '<h3 class="channel-section-title">Manage Subscription Plans</h3>';

    if (plans.length > 0) {
      plans.forEach(function (plan, idx) {
        html += '<div class="plan-card">';
        html += '<div class="plan-card-header"><span class="plan-name">' + u.escapeHtml(plan.label || 'Plan ' + (idx + 1)) + '</span>';
        html += '<span class="plan-price">' + u.formatPrice(plan.price, plan.payToken) + '</span></div>';
        if (plan.description) html += '<div class="plan-desc">' + u.escapeHtml(plan.description) + '</div>';
        if (plan.duration) html += '<div class="plan-duration">Duration: ' + plan.duration.value + ' ' + plan.duration.unit + '</div>';
        html += '<div class="plan-actions">';
        html += '<button class="earnings-withdraw-btn" data-action="edit-plan" data-idx="' + idx + '">Edit</button>';
        html += '<button class="earnings-withdraw-btn" data-action="remove-plan" data-idx="' + idx + '" style="background:#ef4444;">Remove</button>';
        html += '</div>';
        html += '</div>';
      });
    }

    html += '<button id="add-plan-btn" class="btn-primary" style="margin-top:8px">+ Add Plan</button>';

    container.innerHTML = html;

    document.getElementById('add-plan-btn').addEventListener('click', function () {
      openAddPlanModal(channelData);
    });

    container.querySelectorAll('[data-action="edit-plan"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.dataset.idx);
        var plan = plans[idx];
        if (!plan) return;
        openEditPlanModal(channelData, plan);
      });
    });

    container.querySelectorAll('[data-action="remove-plan"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.dataset.idx);
        var plan = plans[idx];
        if (!plan) return;
        btn.disabled = true;
        btn.textContent = '...';
        ElacityAPI.updateSubscriptionPlan(channelData.address, [{ action: 'REMOVE', args: { planId: plan.planId, label: plan.label } }])
          .then(function () {
            u.showToast('Plan removed', 'success');
            btn.parentNode.parentNode.remove();
          })
          .catch(function (err) {
            btn.disabled = false;
            btn.textContent = 'Remove';
            u.showToast('Failed: ' + err.message, 'error');
          });
      });
    });
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
          '<div class="form-group"><label>Price (USDC)</label><input type="number" id="eplan-price" class="form-input" min="0.01" step="0.01" value="' + ((plan.price || 0) / 1e6).toFixed(2) + '" /></div>' +
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
          price: String(Math.round(price * 1e6)),
          payToken: plan.payToken || Wallet.USDC_ADDRESS
        }
      }]).then(function () {
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
          price: String(Math.round(price * 1e6)),
          payToken: Wallet.USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
        }
      }]).then(function () {
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

    var creatorAddr = (channelData.creator && channelData.creator.address) || '';
    var eoaAddr = (Wallet.getAddress() || '').toLowerCase();
    var saAddr = (Wallet.getSmartAccountAddress() || '').toLowerCase();
    var isCreator = Wallet.isConnected() && creatorAddr && (creatorAddr.toLowerCase() === eoaAddr || creatorAddr.toLowerCase() === saAddr);

    if (tokenAccess.length === 0 && !isCreator) return;

    function renderGateUI(accessResult) {
      var hasAccess = accessResult && accessResult.haveAccess;
      var html = '';

      if (tokenAccess.length > 0) {
        html += '<div class="gate-status ' + (hasAccess ? 'granted' : 'denied') + '">' +
          (hasAccess ? '&#10003; Access Granted' : '&#128274; Token-Gated Content') +
        '</div>';
        html += '<div class="gate-requirements">';
        tokenAccess.forEach(function (req) {
          html += '<div class="gate-req-row" style="display:flex;align-items:center;gap:8px;">';
          html += '<span style="flex:1;">Token: ' + u.formatAddress(req.address) + '</span>';
          html += '<span>Min: ' + (req.value || '1') + '</span>';
          if (isCreator) {
            html += '<button class="earnings-withdraw-btn gate-edit-btn" data-gate-addr="' + u.escapeHtml(req.address) + '" data-gate-val="' + u.escapeHtml(String(req.value || '1')) + '">Edit</button>';
            html += '<button class="earnings-withdraw-btn gate-remove-btn" data-gate-addr="' + u.escapeHtml(req.address) + '" style="background:#ef4444;">Remove</button>';
          }
          html += '</div>';
        });
        html += '</div>';
      } else if (isCreator) {
        html += '<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px;">No token-gating rules configured</div>';
      }

      if (isCreator) {
        html += '<button id="add-gate-btn" class="btn-primary btn-icon" style="margin-top:8px">+ Add Token Gate</button>';
      }

      container.innerHTML = html;

      if (isCreator) {
        var addBtn = document.getElementById('add-gate-btn');
        if (addBtn) {
          addBtn.addEventListener('click', function () {
            openTokenGateModal(channelData, null);
          });
        }

        container.querySelectorAll('.gate-edit-btn').forEach(function (btn) {
          btn.addEventListener('click', function () {
            openTokenGateModal(channelData, { address: btn.dataset.gateAddr, value: btn.dataset.gateVal });
          });
        });

        container.querySelectorAll('.gate-remove-btn').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var addr = btn.dataset.gateAddr;
            btn.disabled = true;
            btn.textContent = '...';
            var thresholds = tokenAccess
              .filter(function (t) { return t.address.toLowerCase() !== addr.toLowerCase(); })
              .map(function (t) { return { address: t.address, value: parseFloat(t.value) || 1 }; });
            saveTokenGateConfig(channelData.address, thresholds);
          });
        });
      }
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

    var addrInput = document.getElementById('gate-token-addr');
    if (!isEdit) {
      addrInput.addEventListener('blur', function () {
        var addr = addrInput.value.trim();
        var infoEl = document.getElementById('gate-token-info');
        if (!addr || !ethers.isAddress(addr)) {
          infoEl.textContent = addr ? 'Invalid address' : '';
          infoEl.style.color = '#ef4444';
          return;
        }
        infoEl.textContent = 'Validating...';
        infoEl.style.color = 'var(--text-tertiary)';
        validateTokenContract(addr).then(function (info) {
          if (info) {
            infoEl.textContent = 'Valid: ' + info;
            infoEl.style.color = '#22c55e';
          } else {
            infoEl.textContent = 'Could not verify token — proceed with caution';
            infoEl.style.color = '#f59e0b';
          }
        });
      });
    }

    document.getElementById('gate-save').addEventListener('click', function () {
      var btn = this;
      var addr = document.getElementById('gate-token-addr').value.trim();
      var minBal = document.getElementById('gate-min-bal').value;

      if (!addr || !ethers.isAddress(addr)) {
        u.showToast('Enter a valid token address', 'error');
        return;
      }
      if (!minBal || parseInt(minBal) < 1) {
        u.showToast('Minimum balance must be at least 1', 'error');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Saving...';

      var tokenAccess = channelData.tokenAccess || [];
      var newThresholds = tokenAccess
        .filter(function (t) { return t.address.toLowerCase() !== addr.toLowerCase(); })
        .map(function (t) { return { address: t.address, value: parseFloat(t.value) || 1 }; });
      newThresholds.push({ address: addr, value: parseFloat(minBal) || 1 });

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
      u.showToast('Token gate updated!', 'success');
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

  // ── Hook into earnings view ───────────────────────

  var _origLoadEarningsView = M.loadEarningsView;
  window.ElaMarket.loadEarningsView = function () {
    _origLoadEarningsView();
    setTimeout(function () {
      setupExtraTabs();
      enhanceEarningsItems();
    }, 600);
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
