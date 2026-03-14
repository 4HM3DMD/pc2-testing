/**
 * Elacity GraphQL API client for the Market Browser.
 * Calls the Elacity Base chain API directly.
 */
var ElacityAPI = (function () {
  'use strict';

  var BASE_URL = 'https://base.ela.city/api';
  var GQL_ENDPOINT = BASE_URL + '/2.0/graphql';
  var authToken = null;

  // ── GraphQL Transport ────────────────────────────────

  var signerAddress = null;

  function gql(query, variables, requiresAuth) {
    var headers = { 'Content-Type': 'application/json' };
    if (authToken) {
      headers['Authorization'] = 'Bearer ' + authToken;
    }
    if (requiresAuth && signerAddress) {
      headers['X-ETH-Signer'] = signerAddress;
    }

    var body = variables;
    if (body && body.query && body.query.type) {
      body = JSON.parse(JSON.stringify(body));
      if (!body.query.filterby) body.query.filterby = [];
    }

    return fetch(GQL_ENDPOINT, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ query: query, variables: body })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('API request failed: ' + res.status);
        return res.json();
      })
      .then(function (json) {
        if (json.errors && json.errors.length > 0) {
          if (!json.data || Object.values(json.data).every(function (v) { return v === null; })) {
            throw new Error(json.errors[0].message || 'GraphQL error');
          }
          console.warn('[API] GraphQL partial errors:', json.errors.map(function (e) { return e.message; }));
        }
        return json.data;
      });
  }

  // ── Fragments ────────────────────────────────────────

  var PROFILE_FIELDS = '\n\
    fragment profileFields on Account {\n\
      address\n\
      alias\n\
      avatar\n\
      did {\n\
        trustLevel\n\
        credentials {\n\
          name\n\
          avatar { thumbnail }\n\
        }\n\
      }\n\
    }';

  var NFT_FIELDS = '\n\
    fragment nftFields on ERC721Token {\n\
      _id\n\
      variant\n\
      contractAddress\n\
      tokenID\n\
      hexTokenID\n\
      thumbnailPath\n\
      name\n\
      description\n\
      category\n\
      imageURL\n\
      owner { ...profileFields }\n\
      price\n\
      paymentToken\n\
      createdAt\n\
      listedAt\n\
      saleEndsAt\n\
    }';

  // ── Query: Browse NFTs ───────────────────────────────

  var FETCH_ITEMS_QUERY = '\n\
    query FetchNFTItems($query: NFTItemQueryInput, $filters: FilterPaginationInput) {\n\
      assets: fetchNFTItems(query: $query, filters: $filters) {\n\
        total\n\
        offset\n\
        limit\n\
        data {\n\
          __typename\n\
          ... on StandardAsset {\n\
            ...nftFields\n\
            collection {\n\
              address: erc721Address\n\
              name: collectionName\n\
              creator: owner { ...profileFields }\n\
              description\n\
              imageURL: logoThumbnail\n\
            }\n\
            metadata {\n\
              type\n\
              description\n\
              properties {\n\
                mimeType\n\
                account { ...profileFields }\n\
                royalty\n\
                chainId\n\
              }\n\
            }\n\
          }\n\
          ... on ProtectedAsset {\n\
            ...nftFields\n\
            channel {\n\
              address\n\
              name\n\
              image\n\
              imageURL\n\
              creator { ...profileFields }\n\
              description\n\
              itemsCount\n\
            }\n\
            metadata {\n\
              kid\n\
              media {\n\
                contentType\n\
                protectionType\n\
              }\n\
              properties {\n\
                publisher { ...profileFields }\n\
                authority\n\
                labelType\n\
                distribution\n\
                chainId\n\
              }\n\
              attributes {\n\
                trait_type\n\
                value\n\
              }\n\
            }\n\
            operative {\n\
              opType\n\
              resellerCut\n\
              access {\n\
                totalSupply\n\
                listings {\n\
                  seller\n\
                  quantity\n\
                  price\n\
                  payToken\n\
                }\n\
              }\n\
            }\n\
            access {\n\
              haveAccess\n\
              entitlement\n\
            }\n\
          }\n\
        }\n\
      }\n\
    }\n' + NFT_FIELDS + '\n' + PROFILE_FIELDS;

  // ── Query: NFT Detail ────────────────────────────────

  var GET_ASSET_QUERY = '\n\
    query FetchLedgerAssetPublic($address: String!, $tokenId: TokenID!) {\n\
      nft: getLedgerAsset(address: $address, tokenId: $tokenId) {\n\
        tokenId\n\
        tokenURI\n\
        image\n\
        name\n\
        channel {\n\
          address\n\
          name\n\
          image\n\
          imageURL\n\
          description\n\
          itemsCount\n\
          creator { ...profileFields }\n\
          statistics {\n\
            count\n\
            owners\n\
            floor {\n\
              price\n\
              paymentToken\n\
            }\n\
          }\n\
        }\n\
        metadata {\n\
          kid\n\
          iscc\n\
          name\n\
          description\n\
          properties {\n\
            contract\n\
            publisher { ...profileFields }\n\
            ledger\n\
            chainId\n\
            authority\n\
            labelType\n\
            distribution\n\
          }\n\
          media {\n\
            uri\n\
            contentType\n\
            protectionType\n\
            previewURL\n\
            size\n\
          }\n\
          attributes {\n\
            trait_type\n\
            value\n\
          }\n\
        }\n\
        isProtected\n\
        operative {\n\
          address\n\
          opType\n\
          resellerCut\n\
          access {\n\
            totalSupply\n\
            listings {\n\
              seller\n\
              price\n\
              quantity\n\
              payToken\n\
            }\n\
          }\n\
        }\n\
        views\n\
        createdAt\n\
      }\n\
    }\n' + PROFILE_FIELDS;

  // ── Query: My Accessible Assets ─────────────────────

  var FETCH_ACCESSIBLE_ASSETS_QUERY = '\n\
    query FetchAccessibleAssets($query: LedgerAssetQuery, $filters: FilterPaginationInput) {\n\
      assets: fetchAccessibleAssets(query: $query, filters: $filters) {\n\
        total\n\
        offset\n\
        limit\n\
        data {\n\
          __typename\n\
          ... on ProtectedAsset {\n\
            ...nftFields\n\
            channel {\n\
              address\n\
              name\n\
              image\n\
              imageURL\n\
              creator { ...profileFields }\n\
              description\n\
              itemsCount\n\
            }\n\
            metadata {\n\
              kid\n\
              media {\n\
                contentType\n\
                protectionType\n\
              }\n\
              properties {\n\
                publisher { ...profileFields }\n\
                authority\n\
                labelType\n\
                distribution\n\
                chainId\n\
              }\n\
              attributes {\n\
                trait_type\n\
                value\n\
              }\n\
            }\n\
            operative {\n\
              opType\n\
              resellerCut\n\
              access {\n\
                totalSupply\n\
                listings {\n\
                  seller\n\
                  quantity\n\
                  price\n\
                  payToken\n\
                }\n\
              }\n\
            }\n\
          }\n\
        }\n\
      }\n\
    }\n' + NFT_FIELDS + '\n' + PROFILE_FIELDS;

  // ── Channel Queries ─────────────────────────────────

  var RETRIEVE_CHANNEL_QUERY = '\n\
    query RetrieveChannel($query: ChannelQueryInput) {\n\
      channel: retrieveChannel(query: $query) {\n\
        _id\n\
        name\n\
        address\n\
        description\n\
        channelType\n\
        image\n\
        imageURL\n\
        coverImage\n\
        coverImageURL\n\
        itemsCount\n\
        isPublic\n\
        creator { ...profileFields }\n\
        plans {\n\
          planId\n\
          label\n\
          description\n\
          price\n\
          payToken\n\
          duration {\n\
            unit\n\
            value\n\
          }\n\
        }\n\
      }\n\
    }\n' + PROFILE_FIELDS;

  var LIST_SUBSCRIBERS_QUERY = '\n\
    query ListSubscribers($address: String!, $follower: String) {\n\
      subscribers: listSubscribers(address: $address, follower: $follower) {\n\
        count\n\
        isAmong\n\
      }\n\
    }';

  var CHECK_CHANNEL_ACCESS_QUERY = '\n\
    query CheckChannelAccess($address: String!, $subscriber: String!) {\n\
      access: checkChannelAccess(address: $address, subscriber: $subscriber) {\n\
        haveAccess\n\
        model {\n\
          __typename\n\
          ... on AccessModelOwner {\n\
            isOwner\n\
          }\n\
          ... on AccessModelSubscription {\n\
            planId\n\
            expiresAt\n\
          }\n\
        }\n\
      }\n\
    }';

  var SUBSCRIBE_CHANNEL_MUTATION = '\n\
    mutation SubscribeChannel($to: String!) {\n\
      subscribeChannel(to: $to) {\n\
        _id\n\
      }\n\
    }';

  var UNSUBSCRIBE_CHANNEL_MUTATION = '\n\
    mutation UnsubscribeChannel($to: String!) {\n\
      unsubscribeChannel(to: $to)\n\
    }';

  var FETCH_CHANNELS_QUERY = '\n\
    query FetchChannels($query: ChannelQueryInput, $filters: FilterPaginationInput) {\n\
      channels: fetchChannels(query: $query, filters: $filters) {\n\
        total\n\
        offset\n\
        limit\n\
        data {\n\
          _id\n\
          name\n\
          address\n\
          description\n\
          channelType\n\
          categories\n\
          image\n\
          imageURL\n\
          coverImage\n\
          coverImageURL\n\
          itemsCount\n\
          isPublic\n\
          creator { ...profileFields }\n\
          statistics {\n\
            subscribers\n\
            quote\n\
            floor {\n\
              price\n\
              paymentToken\n\
              priceInUSD\n\
            }\n\
          }\n\
        }\n\
      }\n\
    }\n' + PROFILE_FIELDS;

  var FETCH_CHANNEL_ITEMS_QUERY = '\n\
    query FetchChannelItems($query: LedgerAssetQuery, $filters: FilterPaginationInput) {\n\
      assets: fetchLedgerAssets(query: $query, filters: $filters) {\n\
        total\n\
        offset\n\
        limit\n\
        items {\n\
          address\n\
          tokenId\n\
          tokenURI\n\
          name\n\
          description\n\
          image\n\
          isProtected\n\
          createdAt\n\
          views\n\
          metadata {\n\
            name\n\
            description\n\
            image\n\
            kid\n\
            media {\n\
              uri\n\
              contentType\n\
              previewURL\n\
            }\n\
            properties {\n\
              chainId\n\
              ledger\n\
              authority\n\
              publisher { ...profileFields }\n\
              tags\n\
              categories\n\
            }\n\
            attributes {\n\
              trait_type\n\
              value\n\
            }\n\
          }\n\
          operative {\n\
            opType\n\
            resellerCut\n\
            access {\n\
              totalSupply\n\
              listings {\n\
                seller\n\
                quantity\n\
                price\n\
                payToken\n\
              }\n\
            }\n\
          }\n\
          channel {\n\
            name\n\
            address\n\
            image\n\
            imageURL\n\
          }\n\
        }\n\
      }\n\
    }\n' + PROFILE_FIELDS;

  // ── Watch Later & Likes Queries ─────────────────────

  var GET_USER_PLAYLIST_QUERY = '\n\
    query GetUserPlaylist {\n\
      getUserPlaylist {\n\
        _id\n\
        name\n\
        contents {\n\
          contractAddress\n\
          tokenId\n\
        }\n\
      }\n\
    }';

  var IS_SAVED_TO_LATER_QUERY = '\n\
    query IsSavedToLater($item: PlaylistItemInput!) {\n\
      isSavedToLater(item: $item)\n\
    }';

  var ADD_PLAYLIST_ITEM_MUTATION = '\n\
    mutation AddPlaylistItem($id: String!, $item: PlaylistItemInput!) {\n\
      addPlaylistItem(id: $id, item: $item) {\n\
        _id\n\
        contents {\n\
          contractAddress\n\
          tokenId\n\
        }\n\
      }\n\
    }';

  var REMOVE_PLAYLIST_ITEM_MUTATION = '\n\
    mutation RemovePlaylistItem($id: String!, $item: PlaylistItemInput!) {\n\
      removePlaylistItem(id: $id, item: $item) {\n\
        _id\n\
        contents {\n\
          contractAddress\n\
          tokenId\n\
        }\n\
      }\n\
    }';

  var FETCH_LIKES_QUERY = '\n\
    query FetchLikesByToken($contractAddress: String!, $tokenId: TokenID!, $address: String) {\n\
      likes: fetchLikesByToken(contractAddress: $contractAddress, tokenId: $tokenId, address: $address) {\n\
        count\n\
        isAmong\n\
      }\n\
    }';

  var TOGGLE_LIKE_MUTATION = '\n\
    mutation ToggleLike($contractAddress: String!, $tokenId: TokenID!) {\n\
      toggleLike(contractAddress: $contractAddress, tokenId: $tokenId)\n\
    }';

  // ── Query Presets ────────────────────────────────────

  var PRESETS = {
    buyNow: function (offset, limit) {
      return [
        { type: 'single', variant: 'drm', filterby: ['buyNow'] },
        { offset: offset || 0, limit: limit || 20, sort: { listedAt: -1 } }
      ];
    },
    popular: function (offset, limit) {
      return [
        { type: 'single' },
        { offset: offset || 0, limit: limit || 20, sort: { views: -1 } }
      ];
    },
    all: function (offset, limit) {
      return [
        { type: 'single' },
        { offset: offset || 0, limit: limit || 20, sort: { createdAt: -1 } }
      ];
    },
    myAssets: function (offset, limit) {
      return [
        { type: 'single', variant: 'drm', contentType: ['audio', 'video', 'image'] },
        { offset: offset || 0, limit: limit || 20, sort: { createdAt: -1 } },
        true
      ];
    }
  };

  // ── Auth Queries ─────────────────────────────────────

  var GET_NONCE_QUERY = '\n\
    query GetNonce($address: String!) {\n\
      nonce: getNonce(address: $address)\n\
    }';

  var USER_LOGIN_MUTATION = '\n\
    mutation UserLogin($address: String!, $signature: String!, $sa: String) {\n\
      auth: userLogin(address: $address, signature: $signature, sa: $sa) {\n\
        address\n\
        token\n\
        expiresIn\n\
        sa\n\
      }\n\
    }';

  // ── Public API ───────────────────────────────────────

  function fetchItems(query, filters) {
    return gql(FETCH_ITEMS_QUERY, { query: query, filters: filters })
      .then(function (data) { return data.assets; });
  }

  function getAssetDetail(contractAddress, tokenId) {
    return gql(GET_ASSET_QUERY, { address: contractAddress, tokenId: tokenId })
      .then(function (data) { return data.nft; });
  }

  function getNonce(address) {
    return gql(GET_NONCE_QUERY, { address: address })
      .then(function (data) { return data.nonce; });
  }

  function login(address, signature, sa) {
    console.log('[Auth] login called with address:', address, 'sa:', sa);
    return gql(USER_LOGIN_MUTATION, { address: address, signature: signature, sa: sa || null })
      .then(function (data) {
        console.log('[Auth] login response:', data.auth ? 'token=' + (data.auth.token ? 'yes' : 'no') + ' sa=' + data.auth.sa : 'null');
        if (data.auth && data.auth.token) {
          authToken = data.auth.token;
          signerAddress = (data.auth.sa || address).toLowerCase();
        }
        return data.auth;
      });
  }

  function fetchAccessibleAssets(offset, limit) {
    return gql(
      FETCH_ACCESSIBLE_ASSETS_QUERY,
      { query: {}, filters: { offset: offset || 0, limit: limit || 20, sort: { createdAt: -1 } } },
      true
    ).then(function (data) { return data.assets; });
  }

  function fetchWithPreset(presetName, offset, limit) {
    var preset = PRESETS[presetName];
    if (!preset) throw new Error('Unknown preset: ' + presetName);

    var args = preset(offset, limit);
    var requiresAuth = args[2] === true;

    return gql(FETCH_ITEMS_QUERY, { query: args[0], filters: args[1] }, requiresAuth)
      .then(function (data) { return data.assets; });
  }

  function isAuthenticated() {
    return !!authToken;
  }

  function getAuthToken() {
    return authToken;
  }

  function clearAuth() {
    authToken = null;
    signerAddress = null;
  }

  function setSignerAddress(address) {
    signerAddress = address;
  }

  function retrieveChannel(channelAddress) {
    return gql(RETRIEVE_CHANNEL_QUERY, { query: { address: channelAddress } })
      .then(function (data) { return data.channel; });
  }

  function fetchChannels(offset, limit) {
    return gql(FETCH_CHANNELS_QUERY, {
      query: {},
      filters: { offset: offset || 0, limit: limit || 30, sort: { itemsCount: -1 } }
    }).then(function (data) { return data.channels; });
  }

  function fetchChannelItems(channelAddress, offset, limit) {
    return gql(FETCH_CHANNEL_ITEMS_QUERY, {
      query: { address: channelAddress },
      filters: { offset: offset || 0, limit: limit || 40, sort: { createdAt: -1 } }
    }).then(function (data) { return data.assets; });
  }

  function listSubscribers(channelAddress, followerAddress) {
    return gql(LIST_SUBSCRIBERS_QUERY, {
      address: channelAddress,
      follower: followerAddress || null
    }).then(function (data) { return data.subscribers; });
  }

  function checkChannelAccess(channelAddress, subscriberAddress) {
    return gql(CHECK_CHANNEL_ACCESS_QUERY, {
      address: channelAddress,
      subscriber: subscriberAddress
    }).then(function (data) { return data.access; });
  }

  function subscribeChannel(channelAddress) {
    return gql(SUBSCRIBE_CHANNEL_MUTATION, { to: channelAddress }, true);
  }

  function unsubscribeChannel(channelAddress) {
    return gql(UNSUBSCRIBE_CHANNEL_MUTATION, { to: channelAddress }, true);
  }

  function getSignerAddress() {
    return signerAddress;
  }

  function getUserPlaylist() {
    return gql(GET_USER_PLAYLIST_QUERY, {}, true)
      .then(function (data) { return data.getUserPlaylist; });
  }

  function isSavedToLater(contractAddress, tokenId) {
    return gql(IS_SAVED_TO_LATER_QUERY, {
      item: { contractAddress: contractAddress, tokenId: tokenId }
    }, true)
      .then(function (data) { return data.isSavedToLater; });
  }

  function addPlaylistItem(playlistId, contractAddress, tokenId) {
    return gql(ADD_PLAYLIST_ITEM_MUTATION, {
      id: playlistId,
      item: { contractAddress: contractAddress, tokenId: tokenId }
    }, true);
  }

  function removePlaylistItem(playlistId, contractAddress, tokenId) {
    return gql(REMOVE_PLAYLIST_ITEM_MUTATION, {
      id: playlistId,
      item: { contractAddress: contractAddress, tokenId: tokenId }
    }, true);
  }

  function fetchLikesByToken(contractAddress, tokenId, address) {
    return gql(FETCH_LIKES_QUERY, {
      contractAddress: contractAddress,
      tokenId: tokenId,
      address: address || null
    }).then(function (data) { return data.likes; });
  }

  function toggleLike(contractAddress, tokenId) {
    return gql(TOGGLE_LIKE_MUTATION, {
      contractAddress: contractAddress,
      tokenId: tokenId
    }, true);
  }

  var FETCH_SUBSCRIPTIONS_QUERY = '\
    query QuerySubscriptions($input: SubscriptionQueryInput, $filters: FilterPaginationInput) {\n\
      subscriptions: fetchSubscriptions(query: $input, filters: $filters) {\n\
        total\n\
        data {\n\
          _id\n\
          planId\n\
          expireAt\n\
          channel {\n\
            _id\n\
            address\n\
            name\n\
            image\n\
            imageURL\n\
            itemsCount\n\
          }\n\
        }\n\
      }\n\
    }';

  function fetchSubscriptions(userAddress) {
    return gql(FETCH_SUBSCRIPTIONS_QUERY, {
      input: { user: userAddress },
      filters: { offset: 0, limit: 100 }
    }, true).then(function (res) {
      var subs = res && res.data && res.data.subscriptions;
      return (subs && subs.data) || [];
    }).catch(function () { return []; });
  }

  var INCREMENT_VIEWS_MUTATION = '\
    mutation IncrementViews($address: String!, $tokenId: TokenID!, $owner: String) {\n\
      incrementViews(address: $address, tokenId: $tokenId, owner: $owner)\n\
    }';

  function incrementViews(address, tokenId, owner) {
    return gql(INCREMENT_VIEWS_MUTATION, {
      address: address,
      tokenId: tokenId,
      owner: owner || null
    }).catch(function () {});
  }

  return {
    fetchItems: fetchItems,
    fetchAccessibleAssets: fetchAccessibleAssets,
    fetchWithPreset: fetchWithPreset,
    getAssetDetail: getAssetDetail,
    getNonce: getNonce,
    login: login,
    isAuthenticated: isAuthenticated,
    getAuthToken: getAuthToken,
    clearAuth: clearAuth,
    setSignerAddress: setSignerAddress,
    getSignerAddress: getSignerAddress,
    retrieveChannel: retrieveChannel,
    checkChannelAccess: checkChannelAccess,
    fetchChannels: fetchChannels,
    fetchChannelItems: fetchChannelItems,
    listSubscribers: listSubscribers,
    subscribeChannel: subscribeChannel,
    unsubscribeChannel: unsubscribeChannel,
    getUserPlaylist: getUserPlaylist,
    isSavedToLater: isSavedToLater,
    addPlaylistItem: addPlaylistItem,
    removePlaylistItem: removePlaylistItem,
    fetchLikesByToken: fetchLikesByToken,
    toggleLike: toggleLike,
    incrementViews: incrementViews,
    fetchSubscriptions: fetchSubscriptions,
    PRESETS: PRESETS
  };
})();
