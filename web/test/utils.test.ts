import { describe, expect, test, vi } from 'vitest';
import { describePlayerError, loadYouTubeApi, parseVideoId } from '../src/youtube';
import { loadRecent, pushRecent } from '../src/recent';
import { formatTag } from '../src/format';
import { fmtDuration } from '../src/useSpotifySearch';

const ID = 'dQw4w9WgXcQ';

describe('parseVideoId', () => {
  test.each([
    [ID],
    [`  ${ID}  `],
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}&t=42s&list=PL123`],
    [`https://m.youtube.com/watch?v=${ID}`],
    [`https://music.youtube.com/watch?v=${ID}`],
    [`www.youtube.com/watch?v=${ID}`],
    [`youtube.com/watch?feature=share&v=${ID}`],
    [`https://youtu.be/${ID}`],
    [`https://youtu.be/${ID}?si=abc&t=10`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/embed/${ID}?autoplay=1`],
    [`https://www.youtube.com/live/${ID}`],
    [`https://www.youtube.com/v/${ID}`],
    [`https://www.youtube-nocookie.com/embed/${ID}`],
    [`http://youtube.com/watch?v=${ID}`],
  ])('accepts %s', (input) => {
    expect(parseVideoId(input)).toBe(ID);
  });

  test.each([
    [''],
    ['hello world'],
    ['dQw4w9WgXc'], // 10 chars
    ['dQw4w9WgXcQQ'], // 12 chars
    [`https://evil.com/watch?v=${ID}`],
    [`https://youtube.com.evil.com/watch?v=${ID}`],
    [`https://notyoutube.com/watch?v=${ID}`],
    ['https://www.youtube.com/watch?v=short'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXc%3C'],
    ['https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx'],
    [`https://www.youtube.com/playlist?list=${ID}`],
    ['https://youtu.be/'],
    ['javascript:alert(1)'],
    ['https://'],
  ])('rejects %s', (input) => {
    expect(parseVideoId(input)).toBeNull();
  });
});

describe('describePlayerError', () => {
  test('maps the IFrame API codes', () => {
    expect(describePlayerError(2)).toMatch(/Invalid/);
    expect(describePlayerError(100)).toMatch(/not found/);
    expect(describePlayerError(101)).toMatch(/embedded/);
    expect(describePlayerError(150)).toMatch(/embedded/);
    expect(describePlayerError(999)).toBe('YouTube player error (999)');
  });
});

describe('loadYouTubeApi', () => {
  test('resolves straight away when the API is already loaded', async () => {
    const YT = { Player: vi.fn() };
    window.YT = YT as never;
    await expect(loadYouTubeApi()).resolves.toBe(YT);
    delete window.YT;
  });
});

describe('recent clips', () => {
  test('pushRecent moves to the front, dedupes, caps at 8 and persists', () => {
    let list: number[] = [];
    for (const id of [1, 2, 3, 2]) list = pushRecent(list, id);
    expect(list).toEqual([2, 3, 1]);
    for (let id = 10; id < 20; id++) list = pushRecent(list, id);
    expect(list).toHaveLength(8);
    expect(list[0]).toBe(19);
    expect(loadRecent()).toEqual(list);
  });

  test('loadRecent survives garbage in localStorage', () => {
    for (const raw of ['not json', '{"a":1}', '"str"', 'null']) {
      localStorage.setItem('soundboard_recent', raw);
      expect(loadRecent()).toEqual([]);
    }
    localStorage.setItem('soundboard_recent', JSON.stringify([1, 'x', 2.5, null, 3, ...Array(20).fill(4)]));
    expect(loadRecent()).toEqual([1, 3, 4, 4, 4, 4, 4, 4]);
  });
});

describe('formatTag', () => {
  test.each([
    ['hype', 'Hype'],
    ['gaming time', 'Gaming Time'],
    ['snake_case-tag', 'Snake_Case-Tag'],
    ['ünïcode wörds', 'Ünïcode Wörds'],
    ['日本語', '日本語'],
    ['2fast 4you', '2fast 4you'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(formatTag(input)).toBe(expected);
  });
});

describe('fmtDuration', () => {
  test.each([[0, '0:00'], [59_400, '0:59'], [59_600, '1:00'], [61_000, '1:01'], [3_600_000, '60:00']])('%i ms → %s', (ms, s) => {
    expect(fmtDuration(ms)).toBe(s);
  });
});
