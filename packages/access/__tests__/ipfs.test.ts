import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchFromIpfs } from '../src/fetch/ipfs.js';
import { LOCAL_IPFS_GATEWAY, DEFAULT_IPFS_GATEWAY } from '../src/constants.js';

describe('fetchFromIpfs', () => {
  const MOCK_CID = 'QmTestCid123456789abcdef';
  const MOCK_DATA = new Uint8Array([72, 101, 108, 108, 111]);

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(
    primaryOk: boolean,
    fallbackOk: boolean = true
  ): void {
    let callCount = 0;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      callCount++;
      const urlStr = typeof url === 'string' ? url : url.toString();
      const isPrimary = urlStr.startsWith(LOCAL_IPFS_GATEWAY);

      if (isPrimary && primaryOk) {
        return new Response(MOCK_DATA.buffer, { status: 200 });
      }
      if (!isPrimary && fallbackOk) {
        return new Response(MOCK_DATA.buffer, { status: 200 });
      }
      throw new Error(`Fetch failed for ${urlStr}`);
    }) as typeof globalThis.fetch;
  }

  it('fetches from local gateway first', async () => {
    mockFetch(true);
    await fetchFromIpfs(MOCK_CID);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(`${LOCAL_IPFS_GATEWAY}${MOCK_CID}`);
  });

  it('falls back to Elacity gateway when local fails', async () => {
    mockFetch(false, true);
    await fetchFromIpfs(MOCK_CID);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallbackUrl = fetchMock.mock.calls[1][0] as string;
    expect(fallbackUrl).toBe(`${DEFAULT_IPFS_GATEWAY}${MOCK_CID}`);
  });

  it('strips ipfs:// prefix from CID', async () => {
    mockFetch(true);
    await fetchFromIpfs(`ipfs://${MOCK_CID}`);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(`${LOCAL_IPFS_GATEWAY}${MOCK_CID}`);
  });

  it('uses custom gateways when provided', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(MOCK_DATA.buffer, { status: 200 });
    }) as typeof globalThis.fetch;

    await fetchFromIpfs(MOCK_CID, {
      gateway: 'https://custom.gateway/ipfs/',
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(`https://custom.gateway/ipfs/${MOCK_CID}`);
  });

  it('throws when both gateways fail', async () => {
    mockFetch(false, false);
    await expect(fetchFromIpfs(MOCK_CID)).rejects.toThrow();
  });

  it('returns Uint8Array from response', async () => {
    mockFetch(true);
    const result = await fetchFromIpfs(MOCK_CID);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(MOCK_DATA.length);
  });
});
