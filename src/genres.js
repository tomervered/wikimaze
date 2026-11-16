// Genre filters shown in Stremio's Discover. Stremio sends back the option
// text, so each language gets its own option names mapped to the same genre.
//
// Each genre lists the Wikidata items that mean it: film genres, the
// matching TV genres (Wikidata keeps "drama film" and "drama television
// series" apart) and, for animation and anime, classes (P31). `maze` is
// TVmaze's own genre name, used by the Airing now list.

const GENRES = [
  { key: 'action', en: 'Action', he: 'פעולה', maze: 'Action', ids: ['Q188473', 'Q343782'] },
  { key: 'adventure', en: 'Adventure', he: 'הרפתקאות', maze: 'Adventure', ids: ['Q319221', 'Q56064758'] },
  {
    key: 'animation', en: 'Animation', he: 'אנימציה',
    ids: ['Q202866', 'Q29168811', 'Q581714', 'Q4765080'],
  },
  { key: 'anime', en: 'Anime', he: 'אנימה', maze: 'Anime', ids: ['Q1107', 'Q63952888'], series: true },
  { key: 'biography', en: 'Biography', he: 'ביוגרפיה', ids: ['Q645928'], movie: true },
  { key: 'children', en: 'Children', he: 'ילדים', maze: 'Children', ids: [], series: true },
  {
    key: 'comedy', en: 'Comedy', he: 'קומדיה', maze: 'Comedy',
    ids: ['Q157443', 'Q860626', 'Q9335576', 'Q21010853', 'Q170238', 'Q53094', 'Q20652466', 'Q4765080'],
  },
  { key: 'crime', en: 'Crime', he: 'פשע', maze: 'Crime', ids: ['Q959790', 'Q9335577', 'Q19367312', 'Q113485322'] },
  { key: 'documentary', en: 'Documentary', he: 'תיעודי', maze: 'Documentary', ids: ['Q93204'] },
  {
    key: 'drama', en: 'Drama', he: 'דרמה', maze: 'Drama',
    ids: ['Q130232', 'Q1366112', 'Q1786567', 'Q7210294', 'Q63214877'],
  },
  { key: 'family', en: 'Family', he: 'משפחה', maze: 'Family', ids: ['Q1361932'] },
  { key: 'fantasy', en: 'Fantasy', he: 'פנטזיה', maze: 'Fantasy', ids: ['Q157394', 'Q98526245'] },
  { key: 'history', en: 'History', he: 'היסטוריה', maze: 'History', ids: ['Q17013749', 'Q116514801'] },
  { key: 'horror', en: 'Horror', he: 'אימה', maze: 'Horror', ids: ['Q200092', 'Q20220309', 'Q109629396'] },
  { key: 'legal', en: 'Legal', he: 'משפטי', maze: 'Legal', ids: [], series: true },
  { key: 'medical', en: 'Medical', he: 'רפואי', maze: 'Medical', ids: ['Q1786567'], series: true },
  { key: 'musical', en: 'Musical', he: 'מוזיקלי', ids: ['Q842256'], movie: true },
  { key: 'mystery', en: 'Mystery', he: 'מסתורין', maze: 'Mystery', ids: ['Q1200678', 'Q101898470'] },
  { key: 'romance', en: 'Romance', he: 'רומנטי', maze: 'Romance', ids: ['Q1054574', 'Q860626', 'Q84270297'] },
  {
    key: 'scifi', en: 'Sci-Fi', he: 'מדע בדיוני', maze: 'Science-Fiction',
    ids: ['Q471839', 'Q140472311', 'Q468478'],
  },
  { key: 'sports', en: 'Sports', he: 'ספורט', maze: 'Sports', ids: ['Q1339864'] },
  { key: 'superhero', en: 'Superhero', he: 'גיבורי-על', ids: ['Q1535153'], movie: true },
  { key: 'supernatural', en: 'Supernatural', he: 'על-טבעי', maze: 'Supernatural', ids: [], series: true },
  {
    key: 'thriller', en: 'Thriller', he: 'מתח', maze: 'Thriller',
    ids: ['Q2484376', 'Q67175872', 'Q109733304', 'Q19367312'],
  },
  { key: 'war', en: 'War', he: 'מלחמה', maze: 'War', ids: ['Q369747'] },
  { key: 'western', en: 'Western', he: 'מערבון', maze: 'Western', ids: ['Q172980', 'Q78528852'] },
];

// Which genres a list offers. `source` is 'wikidata' (needs ids) or
// 'tvmaze' (needs a TVmaze name).
function available(type, source) {
  return GENRES.filter((g) => {
    if (type === 'movie' && g.series) return false;
    if (type === 'series' && g.movie) return false;
    return source === 'tvmaze' ? Boolean(g.maze) : g.ids.length > 0;
  });
}

function label(g, lang) {
  return g[lang] || g.en;
}

function options(type, lang, source = 'wikidata') {
  return available(type, source).map((g) => label(g, lang));
}

// Option text (in the install's language or English) back to the genre.
function lookup(type, text, lang, source = 'wikidata') {
  if (!text) return null;
  return available(type, source).find((g) => label(g, lang) === text || g.en === text) || null;
}

module.exports = { options, lookup };
