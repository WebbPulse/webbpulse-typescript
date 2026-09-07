import { describe, expect, it } from 'vitest';
import { joinUrl, serializeQuery } from './query.js';

describe('serializeQuery', () => {
  it('returns an empty string for undefined', () => {
    expect(serializeQuery(undefined)).toBe('');
  });

  it('returns an empty string when every value is dropped', () => {
    expect(serializeQuery({ a: undefined, b: null })).toBe('');
  });

  it('serialises scalars', () => {
    expect(serializeQuery({ page: 2, active: true, q: 'brake' })).toBe(
      'page=2&active=true&q=brake'
    );
  });

  it('repeats the key for array values rather than bracket encoding', () => {
    // Load bearing: the backend's `ids` and `category_ids` parameters depend on
    // the repeated form, and both migration inventories call it out.
    expect(serializeQuery({ ids: [1, 2, 3] })).toBe('ids=1&ids=2&ids=3');
  });

  it('drops null and undefined inside arrays', () => {
    expect(serializeQuery({ ids: [1, null, 2] as unknown as number[] })).toBe(
      'ids=1&ids=2'
    );
  });

  it('does not serialise null as the literal string null', () => {
    expect(serializeQuery({ a: null, b: 1 })).toBe('b=1');
  });

  it('percent encodes keys and values', () => {
    expect(serializeQuery({ 'a key': 'a value&x=1' })).toBe(
      'a%20key=a%20value%26x%3D1'
    );
  });

  it('passes URLSearchParams straight through', () => {
    const params = new URLSearchParams([
      ['ids', '1'],
      ['ids', '2'],
    ]);
    expect(serializeQuery(params)).toBe('ids=1&ids=2');
  });

  it('serialises an empty string value', () => {
    expect(serializeQuery({ q: '' })).toBe('q=');
  });
});

describe('joinUrl', () => {
  it('joins without doubling the separator', () => {
    expect(joinUrl('https://api.example.com/', '/users')).toBe(
      'https://api.example.com/users'
    );
  });

  it('adds the separator when neither side has one', () => {
    expect(joinUrl('https://api.example.com', 'users')).toBe(
      'https://api.example.com/users'
    );
  });

  it('preserves a trailing slash on the path', () => {
    // Portfolio's collection GETs carry a trailing slash and its item routes do
    // not; the distinction reaches TrailingSlashMiddleware and must survive.
    expect(joinUrl('https://api.example.com', '/projects/')).toBe(
      'https://api.example.com/projects/'
    );
  });

  it('returns the base unchanged for an empty path', () => {
    expect(joinUrl('https://api.example.com', '')).toBe(
      'https://api.example.com'
    );
  });
});
