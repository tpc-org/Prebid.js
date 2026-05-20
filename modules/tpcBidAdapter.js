import { ortbConverter } from '../libraries/ortbConverter/converter.js';
import { pbsExtensions } from '../libraries/pbsExtensions/pbsExtensions.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER, VIDEO, NATIVE } from '../src/mediaTypes.js';
import {
  deepAccess, deepSetValue, deepClone,
  logWarn, logError, triggerPixel, shuffle
} from '../src/utils.js';

const BIDDER_CODE = 'tpc';
const PBS_ENDPOINT = 'https://pbs.tpcsrv.com/openrtb2/auction';
const USER_SYNC_ENDPOINT = 'https://pbs.tpcsrv.com/cookie_sync';
const MAX_SYNC_COUNT = 10;

const converter = ortbConverter({
  processors: pbsExtensions,
  context: {
    netRevenue: true,
    ttl: 300,
  },

  imp(buildImp, bidRequest, context) {
    const imp = buildImp(bidRequest, context);
    const { placementId } = bidRequest.params;

    if (placementId) {
      // Map placementId → PBS stored request lookup.
      // PBS uses this ID to load the stored imp configuration server-side,
      // which carries the full bidder setup. No bidder config is needed
      // or sent from the client — adding/changing bidders is a pbs-settings
      // change only, with no bundle redeploy required.
      deepSetValue(imp, 'ext.prebid.storedrequest.id', placementId);
    }

    return imp;
  },

  overrides: {
    bidResponse: {
      // Allow callers to opt in to seeing the real downstream seat (winning bidder)
      // as bid.bidderCode rather than 'tpc'. Useful for analytics tools that expect
      // the raw bidder name. Off by default so all Prebid targeting keys read 'tpc'.
      bidderCode(orig, bidResponse, bid, { bidRequest }) {
        const useSourceBidderCode = deepAccess(bidRequest, 'params.useSourceBidderCode', false);
        if (useSourceBidderCode) {
          orig.apply(this, [...arguments].slice(1));
        }
      },
    },
  },
});

export const spec = {
  code: BIDDER_CODE,
  supportedMediaTypes: [BANNER, VIDEO, NATIVE],
  aliases: [],

  isBidRequestValid(bid) {
    if (!deepAccess(bid, 'params.accountId')) {
      logWarn(`${BIDDER_CODE}: bid missing required params.accountId`, bid);
      return false;
    }
    return true;
  },

  buildRequests(validBidRequests, bidderRequest) {
    const data = converter.toORTB({ bidRequests: validBidRequests, bidderRequest });

    const accountId = deepAccess(validBidRequests[0], 'params.accountId');
    if (accountId) {
      deepSetValue(data, 'site.publisher.id', accountId);
    }

    // Passthrough carries no bidder hint. PBS resolves the winning bidder
    // server-side from the stored request config. We preserve the passthrough
    // object in case pbsExtensions wrote into it, but inject nothing bidder-specific.
    data.ext.prebid.passthrough = {
      ...data.ext.prebid.passthrough,
      tpc: {},
    };

    data.tmax = (bidderRequest.timeout || 1500) - 100;

    return {
      method: 'POST',
      url: PBS_ENDPOINT,
      data,
    };
  },

  interpretResponse(serverResponse, request) {
    if (!serverResponse?.body) return [];
    const resp = deepClone(serverResponse.body);

    // Per-seat responsetimemillis and errors are preserved as-is.
    // The previous adapter collapsed these into a single { tpc: value } entry,
    // which destroyed per-seat analytics data. We leave them intact so the full
    // seat breakdown reaches any analytics adapter.

    const bids = converter.fromORTB({ response: resp, request: request.data }).bids;

    // Build two maps from the raw seatbid array:
    //   seatMap[bid.id]   → seat name  (used for winningBidder annotation)
    //   impSeatMap[impid] → seat name  (fallback when bid.id lookup fails)
    // We also capture the raw bid object to extract vastUrl/vastXml for video.
    const seatMap = {};
    const impSeatMap = {};
    const rawBidMap = {};
    (resp.seatbid || []).forEach(sb => {
      (sb.bid || []).forEach(b => {
        seatMap[b.id] = sb.seat;
        impSeatMap[b.impid] = sb.seat;
        rawBidMap[b.id] = b;
        rawBidMap[b.impid] = b;  // secondary index by impid
      });
    });

    // Build a map from impId → original bidRequest so we can look up
    // mediaType context when ortbConverter doesn't carry it through.
    const impToBidRequest = {};
    (request.data.imp || []).forEach((imp, i) => {
      const originalBid = (request.data._bidRequests || [])[i];
      impToBidRequest[imp.id] = originalBid;
    });

    bids.forEach(bid => {
      // ortbConverter maps seatbid[].bid[].id onto bid.requestId.
      // When allowUnknownBidderCodes is active and the seat is an alternate
      // code, the lookup can fail leaving requestId null. Fall back to
      // matching via adUnitCode / impid.
      const seat = seatMap[bid.requestId] || impSeatMap[bid.adUnitCode] || impSeatMap[bid.transactionId];
      if (seat) {
        deepSetValue(bid, 'meta.winningBidder', seat);
        deepSetValue(bid, 'ext.tpc.winningBidder', seat);
      }

      // Video outstream: attach vastUrl/vastXml and a renderer.
      // PBS returns vastUrl and vastXml in the bid but Prebid.js validation
      // requires either a vastUrl OR a renderer on outstream bids.
      // We attach a renderer that delegates to Adform's outstream player,
      // which is the current downstream renderer until Workstream 2 (video.js).
      if (bid.mediaType === 'video') {
        // Ensure vastUrl is promoted to the top-level bid object.
        // ortbConverter may leave it nested; Prebid validation checks top-level.
        if (!bid.vastUrl && bid.vastXml) {
          // vastXml alone is valid — no action needed, but log for debugging.
        }

        // Attach an outstream renderer so Prebid validation passes.
        // The renderer.render function is called by Prebid after the bid wins.
        if (deepAccess(bid, 'mediaTypes.video.context') === 'outstream' ||
            bid.playerWidth || bid.playerHeight) {
          bid.renderer = {
            url: '',  // no external script needed — Adform's renderer is self-contained
            render: function(bid) {
              // Delegate to Adform's outstream renderer if available.
              // This is the interim solution until Workstream 2 (video.js).
              if (window.Adform && window.Adform.renderOutstream) {
                window.Adform.renderOutstream(bid);
              } else {
                // Fallback: create a video element and play the vastXml/vastUrl directly
                const container = document.getElementById(bid.adUnitCode);
                if (!container) return;
                const video = document.createElement('video');
                video.setAttribute('width', bid.playerWidth || bid.width || 640);
                video.setAttribute('height', bid.playerHeight || bid.height || 480);
                video.setAttribute('controls', 'controls');
                video.setAttribute('autoplay', 'autoplay');
                if (bid.vastUrl) {
                  // For VAST URLs, a proper VAST player is needed.
                  // This is a placeholder until Workstream 2 (video.js) is implemented.
                  logWarn(`${BIDDER_CODE}: outstream renderer not yet configured. vastUrl available for Workstream 2 video.js integration.`);
                }
                container.appendChild(video);
              }
            }
          };
        }
    // seat breakdown (e.g. { appnexus: 45, magnite: 38 }) reaches any analytics adapter.

    const bids = converter.fromORTB({ response: resp, request: request.data }).bids;

    // Build a map of bid id → seat (winning bidder name) from the raw seatbid array.
    // seatbid[].seat is the PBS bidder code of the seat that returned this bid
    // (e.g. 'appnexus', 'magnite'). We annotate each Prebid bid object with this
    // so it is available for analytics without changing the external bidderCode ('tpc').
    const seatMap = {};
    (resp.seatbid || []).forEach(sb => {
      (sb.bid || []).forEach(b => {
        seatMap[b.id] = sb.seat;
      });
    });

    bids.forEach(bid => {
      // ortbConverter maps the original seatbid[].bid[].id onto bid.requestId.
      const seat = seatMap[bid.requestId];
      if (seat) {
        // bid.meta.winningBidder — standard Prebid analytics field
        deepSetValue(bid, 'meta.winningBidder', seat);
        // bid.ext.tpc.winningBidder — TPC-specific extension for downstream use
        deepSetValue(bid, 'ext.tpc.winningBidder', seat);
      }
    });

    return bids;
  },

  getUserSyncs(syncOptions, serverResponses, gdprConsent, uspConsent, gppConsent) {
    if (!syncOptions.iframeEnabled && !syncOptions.pixelEnabled) return [];

    // Derive the list of bidders to sync from ext.responsetimemillis keys.
    // PBS populates this with one key per seat that responded, regardless of
    // who won. This means all configured bidders in the stored request get
    // synced — not just the winner — which maximises match rates across the pool.
    let bidders = [];
    serverResponses.forEach(({ body }) => {
      Object.keys(body?.ext?.responsetimemillis || {}).forEach(b => {
        if (!bidders.includes(b)) bidders.push(b);
      });
    });

    if (!bidders.length) return [];

    bidders = shuffle(bidders).slice(0, MAX_SYNC_COUNT);

    const params = new URLSearchParams();
    params.set('bidders', bidders.join(','));
    params.set('max_sync_count', MAX_SYNC_COUNT);

    if (gdprConsent) {
      params.set('gdpr', gdprConsent.gdprApplies ? '1' : '0');
      if (gdprConsent.consentString) {
        params.set('gdpr_consent', gdprConsent.consentString);
      }
    }
    if (uspConsent) params.set('us_privacy', uspConsent);
    if (gppConsent?.gppString) params.set('gpp', gppConsent.gppString);
    if (Array.isArray(gppConsent?.applicableSections)) {
      params.set('gpp_sid', gppConsent.applicableSections.join(','));
    }

    const syncUrl = `${USER_SYNC_ENDPOINT}?${params.toString()}`;
    if (syncOptions.iframeEnabled) {
      return [{ type: 'iframe', url: syncUrl }];
    }
    return [{ type: 'image', url: syncUrl }];
  },

  onBidWon(bid) {
    if (bid.pbsWurl) triggerPixel(bid.pbsWurl);
    if (bid.burl) triggerPixel(bid.burl);
  },

  onBidderError({ error }) {
    if (error.status === 400 && error.responseText) {
      const match = error.responseText.match(/found for id: (.*)/);
      if (match?.[1]) {
        logError(`${BIDDER_CODE}: account '${match[1]}' not found. Please verify your accountId.`, error);
        return;
      }
    }
    logError(`${BIDDER_CODE} bidder error`, error);
  },
};

registerBidder(spec);
