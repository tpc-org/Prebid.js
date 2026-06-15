import { ortbConverter } from '../libraries/ortbConverter/converter.js';
import { pbsExtensions } from '../libraries/pbsExtensions/pbsExtensions.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { Renderer } from '../src/Renderer.js';
import { BANNER, VIDEO, NATIVE } from '../src/mediaTypes.js';
import {
  deepAccess, deepSetValue, deepClone,
  logWarn, logError, triggerPixel, shuffle
} from '../src/utils.js';

/**
 * tpcBidAdapter — TPC client-side Prebid.js adapter.
 *
 * This is the primary integration path:
 *   PBJS → tpcBidAdapter → PBS → stored request → real bidders (adform, etc.)
 *
 * tpcBidAdapter calls https://pbs.tpcsrv.com/openrtb2/auction directly via
 * buildRequests. PBS resolves the stored imp (referenced via params.placementId)
 * and runs the real bidder mix server-side. Adding a new bidder or changing
 * the bidder mix is a pbs-settings change with no client bundle redeploy.
 *
 * All bids surface as bidderCode 'tpc' for clean targeting. The real seat
 * name is preserved in bid.meta.adapterCode (Prebid standard) and
 * bid.meta.tpc.realBidder (TPC explicit, for analytics).
 *
 * Outstream video bids get a renderer attached that delegates to window.tpc.video,
 * loaded from https://s3.tpcsrv.com/prod/video.js (TPC-hosted, VAST + VPAID).
 *
 * --- Bid params ---
 * accountId            (required) TPC account UUID
 * placementId          (required) PBS stored imp id (per impression)
 * useSourceBidderCode  (optional) if true, surface real seat as bidderCode
 *                                 instead of rewriting to 'tpc'. Default false.
 *
 * --- Alternative s2sConfig integration (not the default) ---
 * Publishers wanting to integrate via Prebid Server's built-in s2s adapter
 * (prebidServerAdapter) can do so without using this adapter; just point
 * s2sConfig.endpoint at https://pbs.tpcsrv.com/openrtb2/auction. That path
 * trades adapter-side logic (bidder rewrite, renderer attachment, analytics
 * fields) for the simpler s2s plumbing — bidder rewrite then has to happen
 * via pbjs.onEvent handlers in the publisher config, and outstream renderers
 * must be declared on each ad unit.
 */

const BIDDER_CODE = 'tpc';
const PBS_ENDPOINT = 'https://pbs.tpcsrv.com/openrtb2/auction';
const USER_SYNC_ENDPOINT = 'https://pbs.tpcsrv.com/cookie_sync';
const OUTSTREAM_RENDERER_URL = 'https://s3.tpcsrv.com/prod/video.js';
const MAX_SYNC_COUNT = 10;

const converter = ortbConverter({
  processors: pbsExtensions,
  context: {
    netRevenue: true,
    ttl: 300,
  },

  imp(buildImp, bidRequest, context) {
    const imp = buildImp(bidRequest, context);
    const { placementId, thrad } = bidRequest.params;

    // Map placementId → PBS stored imp. PBS loads the full bidder configuration
    // server-side from this id, so the client sends no bidder-specific params.
    if (placementId) {
      deepSetValue(imp, 'ext.prebid.storedrequest.id', placementId);
    }

    // Forward dynamic Thrad params (userId, chatId, messages) so PBS can pass
    // them to the thrad adapter. PBS merges these with the stored imp's static
    // thrad params before calling the adapter.
    if (thrad && typeof thrad === 'object') {
      deepSetValue(imp, 'ext.prebid.bidder.thrad', thrad);
    }

    return imp;
  },
});

function attachOutstreamRenderer(bid) {
  const renderer = Renderer.install({
    id: bid.adId,
    url: OUTSTREAM_RENDERER_URL,
    loaded: false,
    adUnitCode: bid.adUnitCode,
  });

  renderer.setRender(function (winningBid) {
    winningBid.renderer.push(function () {
      if (!window.tpc || !window.tpc.video) {
        logWarn(`${BIDDER_CODE}: window.tpc.video not loaded; cannot render outstream video bid`);
        return;
      }
      window.tpc.video.renderAd({
        targetId: winningBid.adUnitCode,
        adResponse: {
          ad: {
            video: {
              content: winningBid.vastXml,
              player_width: winningBid.playerWidth || winningBid.width || 640,
              player_height: winningBid.playerHeight || winningBid.height || 480,
            },
          },
        },
      });
    });
  });

  bid.renderer = renderer;
}

export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: [BANNER, VIDEO, NATIVE],
  aliases: [],

  isBidRequestValid(bid) {
    if (!deepAccess(bid, 'params.accountId')) {
      logWarn(`${BIDDER_CODE}: bid missing required params.accountId`, bid);
      return false;
    }
    if (!deepAccess(bid, 'params.placementId')) {
      logWarn(`${BIDDER_CODE}: bid missing required params.placementId`, bid);
      return false;
    }
    return true;
  },

  buildRequests(validBidRequests, bidderRequest) {
    const data = converter.toORTB({ bidRequests: validBidRequests, bidderRequest });

    // Site publisher — used by PBS to look up account configuration.
    const accountId = deepAccess(validBidRequests[0], 'params.accountId');
    if (accountId) {
      deepSetValue(data, 'site.publisher.id', accountId);
    }

    // Top-level auction stored request — points at the account-level defaults
    // (currency, price granularity, etc.). Set from params or ortb2.
    const auctionStoredRequestId =
      deepAccess(validBidRequests[0], 'params.auctionStoredRequestId') ||
      deepAccess(bidderRequest, 'ortb2.ext.prebid.storedrequest.id');
    if (auctionStoredRequestId) {
      deepSetValue(data, 'ext.prebid.storedrequest.id', auctionStoredRequestId);
    }

    data.ext = data.ext || {};
    data.ext.prebid = data.ext.prebid || {};
    data.ext.prebid.passthrough = {
      ...(data.ext.prebid.passthrough || {}),
      tpc: {},
    };

    data.tmax = (bidderRequest.timeout || 1500) - 100;

    return {
      method: 'POST',
      url: PBS_ENDPOINT,
      data,
      bidRequests: validBidRequests,
    };
  },

  interpretResponse(serverResponse, request) {
    if (!serverResponse || !serverResponse.body) return [];
    const resp = deepClone(serverResponse.body);

    const bids = converter.fromORTB({ response: resp, request: request.data }).bids;

    // Build seat lookup maps so we can attribute each bid to its real seat
    // for analytics. seatMap is keyed by bid.id, impSeatMap by impid as a fallback.
    const seatMap = {};
    const impSeatMap = {};
    (resp.seatbid || []).forEach(function (sb) {
      (sb.bid || []).forEach(function (b) {
        seatMap[b.id] = sb.seat;
        impSeatMap[b.impid] = sb.seat;
      });
    });

    // Per-bid options: read from the original bid request via the response context.
    // useSourceBidderCode is read from the first matching bidRequest.
    const useSourceBidderCode = (request.bidRequests || []).some(function (br) {
      return deepAccess(br, 'params.useSourceBidderCode') === true;
    });

    bids.forEach(function (bid) {
      const realSeat =
        seatMap[bid.requestId] ||
        impSeatMap[bid.adUnitCode] ||
        impSeatMap[bid.transactionId];

      // Preserve real seat name in TPC-specific meta field for analytics.
      // bid.meta.adapterCode is already set by Prebid to the real seat name.
      if (realSeat) {
        bid.meta = bid.meta || {};
        bid.meta.tpc = bid.meta.tpc || {};
        bid.meta.tpc.realBidder = realSeat;
      }

      // Rewrite bidderCode to 'tpc' unless opted out via params.useSourceBidderCode.
      // This keeps all targeting keys (hb_bidder, hb_pb_BIDDER) uniform under 'tpc'.
      if (!useSourceBidderCode) {
        bid.bidderCode = BIDDER_CODE;
      }

      // Outstream video bids need a renderer for Prebid validation to pass.
      // ortbConverter sets bid.mediaType = 'video' for video responses.
      // Outstream context comes from the original ad unit's mediaTypes.video.context.
      if (bid.mediaType === VIDEO) {
        const matchingBidRequest = (request.bidRequests || []).find(function (br) {
          return br.adUnitCode === bid.adUnitCode || br.bidId === bid.requestId;
        });
        const videoContext = deepAccess(matchingBidRequest, 'mediaTypes.video.context');
        if (videoContext === 'outstream') {
          attachOutstreamRenderer(bid);
        }
      }
    });

    return bids;
  },

  getUserSyncs(syncOptions, serverResponses, gdprConsent, uspConsent, gppConsent) {
    if (!syncOptions.iframeEnabled && !syncOptions.pixelEnabled) return [];

    let bidders = [];
    serverResponses.forEach(function (resp) {
      const rtm = (resp.body && resp.body.ext && resp.body.ext.responsetimemillis) || {};
      Object.keys(rtm).forEach(function (b) {
        if (!bidders.includes(b)) bidders.push(b);
      });
    });

    if (!bidders.length) return [];

    bidders = shuffle(bidders).slice(0, MAX_SYNC_COUNT);

    const body = { bidders, limit: MAX_SYNC_COUNT, coopSync: false };
    if (gdprConsent) {
      body.gdpr = gdprConsent.gdprApplies ? 1 : 0;
      if (gdprConsent.consentString) body.gdpr_consent = gdprConsent.consentString;
    }
    if (uspConsent) body.us_privacy = uspConsent;
    if (gppConsent && gppConsent.gppString) body.gpp = gppConsent.gppString;
    if (Array.isArray(gppConsent && gppConsent.applicableSections)) {
      body.gpp_sid = gppConsent.applicableSections.join(',');
    }

    // PBS cookie_sync is POST-only; fire async and inject resulting sync
    // pixels/iframes directly — getUserSyncs must return synchronously.
    fetch(USER_SYNC_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(data => {
        (data.bidder_status || []).forEach(function (bs) {
          if (!bs.usersync || !bs.usersync.url) return;
          const type = bs.usersync.type;
          if (type === 'iframe' && syncOptions.iframeEnabled) {
            const iframe = document.createElement('iframe');
            iframe.src = bs.usersync.url;
            iframe.style.cssText = 'display:none;width:0;height:0;border:0;';
            document.body.appendChild(iframe);
          } else if ((type === 'redirect' || type === 'image') && syncOptions.pixelEnabled) {
            triggerPixel(bs.usersync.url);
          }
        });
      })
      .catch(function () {});

    return [];
  },

  onBidWon(bid) {
    if (bid.pbsWurl) triggerPixel(bid.pbsWurl);
    if (bid.burl) triggerPixel(bid.burl);
  },

  onBidderError(args) {
    const error = args && args.error;
    if (error && error.status === 400 && error.responseText) {
      const match = error.responseText.match(/found for id: (.*)/);
      if (match && match[1]) {
        logError(`${BIDDER_CODE}: account '${match[1]}' not found. Please verify your accountId.`, error);
        return;
      }
    }
    logError(`${BIDDER_CODE} bidder error`, error);
  },
};

registerBidder(spec);
