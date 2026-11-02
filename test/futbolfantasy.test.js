const test = require('node:test');
const assert = require('node:assert');
const { parseList, parseMatch, matchPlayers, score } = require('../src/futbolfantasy.js');

const wrap = (id, role, prob, slug, short) => `<div class="jugador_${id} campo camiseta-wrapper" style="left: 50%" data-index="1" data-onceFF="${role}" > <a class="camiseta " data-probabilidad="${prob}%" href="https://www.futbolfantasy.com/jugadores/${slug}/laliga-26-27"></a> <div class="juggadores"><a class="juggador" href="https://www.futbolfantasy.com/jugadores/${slug}/laliga-26-27"><span class="truncate-name mx-auto">${short}</span></a></div></div>`;

test('list page: only the main jornada block, max 10 matches', () => {
  const html = '<h1>Jornada 8</h1><section class="mod proxjornada mw-50-desktop"><a href="https://www.futbolfantasy.com/partidos/1-a-b"></a><a href="https://www.futbolfantasy.com/partidos/2-c-d"></a></section></main><aside><a href="https://www.futbolfantasy.com/partidos/3-e-f"></a></aside>';
  const r = parseList(html);
  assert.strictEqual(r.week, 8);
  assert.deepStrictEqual(r.urls, ['https://www.futbolfantasy.com/partidos/1-a-b', 'https://www.futbolfantasy.com/partidos/2-c-d']);
});

test('match page: probability, role, slug and short name per player', () => {
  const ps = parseMatch(wrap(1, 'titular', 90, 'sergio-camello', 'Camello') + wrap(2, 'suplente', 30, 'scar-valentin', 'Valentín'));
  assert.deepStrictEqual(ps.map(p => [p.prob, p.role, p.slug, p.short]), [[90, 'titular', 'sergio-camello', 'Camello'], [30, 'suplente', 'scar-valentin', 'Valentín']]);
});

test('name matching: initials, accents dropped from slugs, team filter, short name tiebreak', () => {
  assert.ok(score('O. Sancet', ['oihan', 'sancet']) > 0);
  assert.ok(score('Arda Güler', ['arda', 'gler']) > 0);
  assert.strictEqual(score('Jonny Otto', ['jonny', 'castro']), 0);
  const api = [
    { id: 1, nickname: 'Giuliano', teamId: 2 }, { id: 2, nickname: 'Simeone', teamId: 2 }, { id: 3, nickname: 'Navarro', teamId: 3 },
    { id: 4, nickname: 'Ximo Navarro', teamId: 26 }, { id: 5, nickname: 'Oblak', teamId: 2 }, { id: 6, nickname: 'Koke', teamId: 2 },
    { id: 7, nickname: 'Comas', teamId: 26 }, { id: 8, nickname: 'Pathé I. Ciss', teamId: 26 }
  ];
  const ff = [
    { slug: 'giuliano-simeone', short: 'Giuliano', prob: 80, role: 'titular' }, { slug: 'jan-oblak', short: 'Oblak', prob: 95, role: 'titular' },
    { slug: 'koke', short: 'Koke', prob: 50, role: 'titular' }, { slug: 'ximo-navarro', short: 'Ximo Navarro', prob: 70, role: 'titular' },
    { slug: 'arnau-comas', short: 'Comas', prob: 0, role: 'suplente' }, { slug: 'pathe-ciss', short: 'Pathé Ciss', prob: 80, role: 'titular' }
  ];
  const r = matchPlayers(ff, api);
  assert.deepStrictEqual(r.teams.sort(), ['2', '26']);
  assert.strictEqual(r.byId['1'].prob, 80);
  assert.strictEqual(r.byId['2'], undefined);
  assert.strictEqual(r.byId['4'].prob, 70);
  assert.strictEqual(r.byId['3'], undefined);
  assert.strictEqual(r.byId['8'].prob, 80);
});

