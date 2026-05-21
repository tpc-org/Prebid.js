import { spec } from 'modules/tpcBidAdapter.js';

const expect = require('chai').expect;

const PBS_HOST = 'pbs.tpcsrv.com';
const ACCOUNT_ID = 'pub-1234';
const PLACEMENT_ID = 'sayhola-37c0d0d2'; // stored request ID — maps to PBS stored imp
const TEST_DOMAIN = 'example.com';
const TEST_PAGE = `https://${TEST_DOMAIN}/page.html`;
const ADUNIT_CODE = '/1234/header-bid-tag-0';

const BID_PARAMS = {
  params: {
    accountId: ACCOUNT_ID,
    placementId: PLACEMENT_ID,
  }
};

const BID_REQUEST = {
  bidder: 'tpc',
  ...BID_PARAMS,
  ortb2Imp: {
    ext: {
      tid: 'e13391ea-00f3-495d-99a6-d937990d73a9'
    }
  },
  mediaTypes: {
    banner: {
      sizes: [
        [300, 250]
      ]
    }
  },
  adUnitCode: ADUNIT_CODE,
  transactionId: 'e13391ea-00f3-495d-99a6-d937990d73a9',
  sizes: [[300, 250]],
  bidId: '123456789',
  bidderRequestId: '1decd098c76ed2',
  auctionId: '251a6a36-a5c5-4b82-b2b3-538c148a29dd',
  src: 'client',
  bidRequestsCount: 1,
  bidderRequestsCount: 1,
  bidderWinsCount: 0,
  ortb2: {
    site: {
      page: TEST_PAGE,
      domain: TEST_DOMAIN,
      publisher: {
        domain: TEST_DOMAIN
      }
    },
    device: {
      w: 1848,
      h: 1007,
      dnt: 0,
      ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',
      language: 'en',
    }
  }
};

const BIDDER_REQUEST = {
  bidderCode: BID_REQUEST.bidder,
  auctionId: BID_REQUEST.auctionId,
  bidderRequestId: BID_REQUEST.bidderRequestId,
  bids: [BID_REQUEST],
  ortb2: BID_REQUEST.ortb2,
  auctionStart: 1681224591370,
  timeout: 1000,
  refererInfo: {
    reachedTop: true,
    isAmp: false,
    numIframes: 0,
    stack: [TEST_PAGE],
    topmostLocation: TEST_PAGE,
    location: TEST_PAGE,
    canonicalUrl: null,
    page: TEST_PAGE,
    domain: TEST_DOMAIN,
    ref: null,
  },
  start: 1681224591375
};

// BID_RESPONSE simulates a PBS response where the stored request resolved to
// two seats (appnexus + magnite) and appnexus won.
const WINNING_SEAT = 'appnexus';
const BID_ID = '123456789';

const BID_RESPONSE = {
  seatbid: [
    {
      bid: [
        {
          id: BID_ID,
          impid: BID_REQUEST.bidId,
          price: 1.5,
          adm: '<img src="//files.prebid.org/creatives/prebid300x250.png" />',
          adomain: ['example.com'],
          crid: 'creative-abc-123',
          w: 300,
          h: 250,
          exp: 300,
          mtype: 1,
          ext: {
            prebid: {
              type: 'banner',
              targeting: {
                hb_size: '300x250',
                hb_bidder: 'tpc',
                hb_pb: '1.50'
              },
              meta: {
                advertiserDomains: ['example.com']
              }
            },
            origbidcpm: 1.5
          }
        }
      ],
      seat: WINNING_SEAT,
      group: 0
    }
  ],
  cur: 'USD',
  ext: {
    // Per-seat timing — both seats responded even though only appnexus won.
    // getUserSyncs uses these keys to trigger syncs for all responding seats.
    responsetimemillis: {
      appnexus: 50,
      magnite: 38,
    },
    tmaxrequest: 900,
    prebid: {
      auctiontimestamp: 1678646619765,
      passthrough: {
        tpc: {}
      }
    }
  }
};

const buildRequest = (params = {}) => {
  const bidRequest = {
    ...BID_REQUEST,
    params: {
      ...BID_REQUEST.params,
      ...params,
    },
  };
  return spec.buildRequests([bidRequest], BIDDER_REQUEST);
};

// ─── Video / outstream fixtures ──────────────────────────────────────────────

const VIDEO_BID_ID = 'video-bid-789';
const VIDEO_ADUNIT_CODE = 'tpc-hola-video';
const VAST_XML = '<VAST version="2.0"><Ad id="1"><InLine><AdTitle>Test</AdTitle><Creatives><Creative><Linear><MediaFiles><MediaFile type="video/mp4" delivery="progressive">https://example.com/ad.mp4</MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>';

const VIDEO_BID_REQUEST = {
  ...BID_REQUEST,
  adUnitCode: VIDEO_ADUNIT_CODE,
  bidId: VIDEO_BID_ID,
  mediaTypes: {
    video: {
      context: 'outstream',
      playerSize: [[640, 480]],
      mimes: ['video/mp4'],
    }
  }
};

const VIDEO_BIDDER_REQUEST = {
  ...BIDDER_REQUEST,
  bids: [VIDEO_BID_REQUEST],
};

const VIDEO_BID_RESPONSE = {
  seatbid: [{
    bid: [{
      id: VIDEO_BID_ID,
      impid: VIDEO_BID_ID,
      price: 2.0,
      adm: VAST_XML,
      adomain: ['example.com'],
      crid: 'video-crid-123',
      w: 640,
      h: 480,
      exp: 300,
      mtype: 2,
      ext: { prebid: { type: 'video' } }
    }],
    seat: 'adform',
    group: 0,
  }],
  cur: 'USD',
  ext: {
    responsetimemillis: { adform: 45 },
    tmaxrequest: 900,
    prebid: { auctiontimestamp: 1678646619765, passthrough: { tpc: {} } }
  }
};

describe('TPC Bid Adapter', function () {
  // ─── isBidRequestValid ──────────────────────────────────────────────────────

  describe('isBidRequestValid', () => {
    it('should return true for a valid bid with accountId', () => {
      expect(spec.isBidRequestValid(BID_REQUEST)).to.be.true;
    });
    it('should return false when accountId is missing', () => {
      const bid = { ...BID_REQUEST, params: {} };
      expect(spec.isBidRequestValid(bid)).to.be.false;
    });
  });

  // ─── buildRequests ──────────────────────────────────────────────────────────

  describe('buildRequests', () => {
    const { data, url } = buildRequest();

    it('should POST to the correct PBS endpoint', () => {
      expect(url).equal(`https://${PBS_HOST}/openrtb2/auction`);
    });
    it('should set site.publisher.id to the accountId', () => {
      expect(data.site.publisher.id).equal(ACCOUNT_ID);
    });
    it('should set tmax below the bidder timeout', () => {
      expect(data.tmax).be.greaterThan(0);
      expect(data.tmax).be.lessThan(BIDDER_REQUEST.timeout);
    });

    // Stored-request routing: placementId maps to ext.prebid.storedrequest.id
    // so PBS performs the stored imp lookup and resolves bidders server-side.
    it('should map placementId to imp.ext.prebid.storedrequest.id', () => {
      expect(data.imp[0].ext.prebid.storedrequest.id).equal(PLACEMENT_ID);
    });

    // The passthrough must NOT carry a downstream bidder name.
    // Bidder resolution is entirely server-side via the stored request.
    it('should not carry a downstream bidder name in the passthrough', () => {
      expect(data.ext.prebid.passthrough.tpc.bidder).to.be.undefined;
    });
  });

  describe('buildRequests without placementId', () => {
    const { data } = buildRequest({ placementId: undefined });
    it('should not set storedrequest.id when placementId is not provided', () => {
      expect(data.imp[0].ext?.prebid?.storedrequest?.id).to.be.undefined;
    });
  });

  // ─── interpretResponse ──────────────────────────────────────────────────────

  describe('interpretResponse', () => {
    const request = buildRequest();
    const [bid] = spec.interpretResponse({ body: BID_RESPONSE }, request);

    it('should return the correct bid values', () => {
      const respBid = BID_RESPONSE.seatbid[0].bid[0];
      expect(bid.cpm).equal(respBid.price);
      expect(bid.ad).equal(respBid.adm);
      expect(bid.width).equal(respBid.w);
      expect(bid.height).equal(respBid.h);
    });

    // bidderCode stays 'tpc' by default so all Prebid targeting keys read 'tpc'.
    // The real seat is surfaced separately via meta/ext for analytics use.
    it('should not expose the S2S seat as bidderCode by default', () => {
      expect(bid.bidderCode).not.equal(WINNING_SEAT);
    });

    // Winning bidder annotation — available for analytics without affecting targeting.
    it('should annotate bid.meta.tpc.realBidder with the winning seat', () => {
      expect(bid.meta.tpc.realBidder).equal(WINNING_SEAT);
    });
    it('should set bid.meta.tpc as an object', () => {
      expect(bid.meta.tpc).to.be.an('object');
    });

    // Per-seat responsetimemillis must be preserved intact — not collapsed.
    // Analytics adapters and getUserSyncs both rely on the full seat breakdown.
    it('should preserve per-seat responsetimemillis for all responding seats', () => {
      expect(BID_RESPONSE.ext.responsetimemillis).to.deep.equal({ appnexus: 50, magnite: 38 });
    });

    it('should return an empty array when there is no body', () => {
      expect(spec.interpretResponse({}, request)).to.deep.equal([]);
    });
  });

  describe('interpretResponse with useSourceBidderCode', () => {
    const request = buildRequest({ useSourceBidderCode: true });
    request.bidRequests = [{ params: { accountId: ACCOUNT_ID, placementId: PLACEMENT_ID, useSourceBidderCode: true } }];
    const [bid] = spec.interpretResponse({ body: BID_RESPONSE }, request);
    it('should expose the S2S seat as bidderCode when useSourceBidderCode is true', () => {
      expect(bid.bidderCode).equal(WINNING_SEAT);
    });
  });

  // ─── getUserSyncs ────────────────────────────────────────────────────────────
  // PBS cookie_sync is POST-only. getUserSyncs fires an async POST and injects
  // resulting sync pixels/iframes directly; it always returns [] synchronously.

  describe('getUserSyncs', () => {
    let fetchStub;
    const emptyCookieSyncResponse = { json: () => Promise.resolve({ bidder_status: [] }) };

    beforeEach(() => {
      fetchStub = sinon.stub(window, 'fetch').resolves(emptyCookieSyncResponse);
    });

    afterEach(() => {
      fetchStub.restore();
    });

    it('always returns an empty array synchronously', () => {
      expect(spec.getUserSyncs({ iframeEnabled: true }, [{ body: BID_RESPONSE }])).to.deep.equal([]);
    });

    it('does not fetch when both sync options are disabled', () => {
      spec.getUserSyncs({ iframeEnabled: false, pixelEnabled: false }, [{ body: BID_RESPONSE }]);
      expect(fetchStub.called).to.be.false;
    });

    it('does not fetch when no bidders are in the response', () => {
      spec.getUserSyncs({ iframeEnabled: true }, [{ body: {} }]);
      expect(fetchStub.called).to.be.false;
    });

    it('POSTs to the cookie_sync endpoint with all responding bidders', () => {
      spec.getUserSyncs({ iframeEnabled: true }, [{ body: BID_RESPONSE }], null, null, null);
      expect(fetchStub.calledOnce).to.be.true;
      const [url, opts] = fetchStub.firstCall.args;
      expect(url).to.include('/cookie_sync');
      expect(opts.method).to.equal('POST');
      const body = JSON.parse(opts.body);
      expect(body.bidders).to.include('appnexus');
      expect(body.bidders).to.include('magnite');
    });

    // credentials: 'include' is required so the browser sends and updates the
    // uids cookie cross-origin. Without it PBS returns no_cookie: true.
    it('sends the request with credentials: include for cross-origin cookie handling', () => {
      spec.getUserSyncs({ iframeEnabled: true }, [{ body: BID_RESPONSE }]);
      const opts = fetchStub.firstCall.args[1];
      expect(opts.credentials).to.equal('include');
    });

    it('includes GDPR consent params in the POST body', () => {
      spec.getUserSyncs(
        { iframeEnabled: true },
        [{ body: BID_RESPONSE }],
        { gdprApplies: true, consentString: 'abc123' },
        null, null
      );
      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      expect(body.gdpr).to.equal(1);
      expect(body.gdpr_consent).to.equal('abc123');
    });

    it('includes US Privacy param in the POST body', () => {
      spec.getUserSyncs({ pixelEnabled: true }, [{ body: BID_RESPONSE }], null, '1YNN', null);
      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      expect(body.us_privacy).to.equal('1YNN');
    });
  });

  // ─── interpretResponse — outstream renderer ──────────────────────────────────

  describe('interpretResponse — outstream renderer', () => {
    let renderAdStub;
    const videoRequest = spec.buildRequests([VIDEO_BID_REQUEST], VIDEO_BIDDER_REQUEST);

    beforeEach(() => {
      renderAdStub = sinon.stub();
      window.tpc = { video: { renderAd: renderAdStub } };
    });

    afterEach(() => {
      delete window.tpc;
    });

    it('attaches a renderer to an outstream video bid', () => {
      const [bid] = spec.interpretResponse({ body: VIDEO_BID_RESPONSE }, videoRequest);
      expect(bid.renderer).to.exist;
    });

    it('renderer URL points at the TPC hosted video player', () => {
      const [bid] = spec.interpretResponse({ body: VIDEO_BID_RESPONSE }, videoRequest);
      expect(bid.renderer.url).to.include('s3.tpcsrv.com');
    });

    // Verifies the render function passes vastXml and targetId to window.tpc.video.renderAd.
    // bid.adUnitCode is set by Prebid's auction manager before rendering; set manually here.
    // bid.vastXml is set by the ortbConverter video processor (requires FEATURES.VIDEO at
    // build time, which is disabled in this test env); set manually here to test render logic.
    // renderer.loaded = true makes push() fire synchronously without loading the external script.
    it('renderer calls window.tpc.video.renderAd with vastXml and targetId', () => {
      const [bid] = spec.interpretResponse({ body: VIDEO_BID_RESPONSE }, videoRequest);
      bid.adUnitCode = VIDEO_ADUNIT_CODE;
      bid.vastXml = VAST_XML;
      bid.renderer.loaded = true;
      bid.renderer._render(bid);
      expect(renderAdStub.calledOnce).to.be.true;
      const args = renderAdStub.firstCall.args[0];
      expect(args.targetId).to.equal(VIDEO_ADUNIT_CODE);
      expect(args.adResponse.ad.video.content).to.equal(VAST_XML);
    });

    it('does not attach a renderer to an instream video bid', () => {
      const instreamBidRequest = {
        ...VIDEO_BID_REQUEST,
        mediaTypes: { video: { context: 'instream', playerSize: [[640, 480]] } }
      };
      const instreamRequest = spec.buildRequests(
        [instreamBidRequest],
        { ...VIDEO_BIDDER_REQUEST, bids: [instreamBidRequest] }
      );
      const [bid] = spec.interpretResponse({ body: VIDEO_BID_RESPONSE }, instreamRequest);
      expect(bid.renderer).to.be.undefined;
    });
  });
});
