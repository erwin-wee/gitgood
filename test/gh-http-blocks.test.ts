import { describe, expect, it } from 'vitest';
import { parseHttpBlocks } from '../src/main/gh/gh';

describe('parseHttpBlocks', () => {
  it('parses a single status/headers/body block', () => {
    const text = ['HTTP/2.0 200 OK', 'Date: Thu, 25 Oct 2018 16:32:53 GMT', 'X-Poll-Interval: 60', 'Last-Modified: Thu, 25 Oct 2018 16:32:53 GMT', '', '[{"id":"1"}]', ''].join('\r\n');
    const blocks = parseHttpBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].status).toBe(200);
    expect(blocks[0].headers['x-poll-interval']).toBe('60');
    expect(blocks[0].headers['last-modified']).toBe('Thu, 25 Oct 2018 16:32:53 GMT');
    expect(blocks[0].body).toBe('[{"id":"1"}]');
  });

  it('lower-cases header names so lookups are case-insensitive', () => {
    const text = ['HTTP/2.0 200 OK', 'X-Poll-Interval: 90', '', '[]'].join('\n');
    expect(parseHttpBlocks(text)[0].headers['x-poll-interval']).toBe('90');
  });

  it('parses repeated blocks from --paginate --include, one per page', () => {
    const text = [
      'HTTP/2.0 200 OK',
      'Link: <https://api.github.com/notifications?page=2>; rel="next"',
      '',
      '[{"id":"1"}]',
      'HTTP/2.0 200 OK',
      'Link: <https://api.github.com/notifications?page=3>; rel="prev"',
      '',
      '[{"id":"2"}]',
    ].join('\n');
    const blocks = parseHttpBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].body).toBe('[{"id":"1"}]');
    expect(blocks[1].body).toBe('[{"id":"2"}]');
  });

  it('parses a 304 Not Modified block with an empty body', () => {
    const text = ['HTTP/2.0 304 Not Modified', 'X-Poll-Interval: 60', ''].join('\n');
    const blocks = parseHttpBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].status).toBe(304);
    expect(blocks[0].body).toBe('');
  });

  it('returns no blocks for text with no HTTP status line', () => {
    expect(parseHttpBlocks('')).toEqual([]);
    expect(parseHttpBlocks('not an http response')).toEqual([]);
  });
});
