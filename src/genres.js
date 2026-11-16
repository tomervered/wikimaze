// Genre filters shown in Stremio's Discover. Stremio sends back the option
// text, so each language gets its own option names mapped to the same ids.
//
// Movies: Wikidata genre items (matched on P136 genre, or P31 for
// "animated film", which Wikidata often records as the item's class).
// Series: TVmaze's own genre names.

const MOVIE = [
  { id: ['Q188473'], en: 'Action', he: 'פעולה' },
  { id: ['Q319221'], en: 'Adventure', he: 'הרפתקאות' },
  { id: ['Q202866', 'Q29168811'], en: 'Animation', he: 'אנימציה' },
  { id: ['Q645928'], en: 'Biography', he: 'ביוגרפיה' },
  { id: ['Q157443', 'Q860626'], en: 'Comedy', he: 'קומדיה' },
  { id: ['Q959790'], en: 'Crime', he: 'פשע' },
  { id: ['Q93204'], en: 'Documentary', he: 'תיעודי' },
  { id: ['Q130232'], en: 'Drama', he: 'דרמה' },
  { id: ['Q1361932'], en: 'Family', he: 'משפחה' },
  { id: ['Q157394'], en: 'Fantasy', he: 'פנטזיה' },
  { id: ['Q17013749'], en: 'History', he: 'היסטוריה' },
  { id: ['Q200092'], en: 'Horror', he: 'אימה' },
  { id: ['Q842256'], en: 'Musical', he: 'מוזיקלי' },
  { id: ['Q1200678'], en: 'Mystery', he: 'מסתורין' },
  { id: ['Q1054574', 'Q860626'], en: 'Romance', he: 'רומנטי' },
  { id: ['Q471839'], en: 'Sci-Fi', he: 'מדע בדיוני' },
  { id: ['Q1535153'], en: 'Superhero', he: 'גיבורי-על' },
  { id: ['Q2484376'], en: 'Thriller', he: 'מתח' },
  { id: ['Q369747'], en: 'War', he: 'מלחמה' },
  { id: ['Q172980'], en: 'Western', he: 'מערבון' },
];

const SERIES = [
  { id: 'Action', he: 'פעולה' },
  { id: 'Adventure', he: 'הרפתקאות' },
  { id: 'Anime', he: 'אנימה' },
  { id: 'Children', he: 'ילדים' },
  { id: 'Comedy', he: 'קומדיה' },
  { id: 'Crime', he: 'פשע' },
  { id: 'Documentary', he: 'תיעודי' },
  { id: 'Drama', he: 'דרמה' },
  { id: 'Family', he: 'משפחה' },
  { id: 'Fantasy', he: 'פנטזיה' },
  { id: 'History', he: 'היסטוריה' },
  { id: 'Horror', he: 'אימה' },
  { id: 'Legal', he: 'משפטי' },
  { id: 'Medical', he: 'רפואי' },
  { id: 'Mystery', he: 'מסתורין' },
  { id: 'Romance', he: 'רומנטי' },
  { id: 'Science-Fiction', he: 'מדע בדיוני' },
  { id: 'Sports', he: 'ספורט' },
  { id: 'Supernatural', he: 'על-טבעי' },
  { id: 'Thriller', he: 'מתח' },
  { id: 'War', he: 'מלחמה' },
  { id: 'Western', he: 'מערבון' },
].map((g) => ({ ...g, en: g.id }));

const TABLES = { movie: MOVIE, series: SERIES };

function name(g, lang) {
  return g[lang] || g.en;
}

function options(type, lang) {
  return TABLES[type].map((g) => name(g, lang));
}

// Option text (in any language) back to the genre's id.
function lookup(type, text, lang) {
  if (!text) return null;
  const g = TABLES[type].find((x) => name(x, lang) === text || x.en === text);
  return g ? g.id : null;
}

module.exports = { options, lookup };
