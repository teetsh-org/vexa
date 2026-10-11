/**
 * Forced-language guard — applied at the stt.v1 egress when the invocation forces a language.
 *
 * Some OpenAI-compatible backends (Mistral Voxtral) accept `language` but do not constrain the
 * decode with it: on short, faint or overlapping audio they return text in another language
 * ("Ну да.", "Mamá él me apela.", "So let's" in a French meeting). Those windows are hallucinations
 * or cross-talk, never what the meeting asked for, so the client drops them.
 *
 * Two signals, both cheap and dependency-free:
 *  • script — most letters outside the forced language's script (Cyrillic in a French meeting);
 *  • markers — for Latin-script languages, function words and diacritics distinctive of a language.
 *    A window is foreign when another language has strictly more markers than the forced one.
 *
 * Ties and marker-free text (names, "OK", numbers) are kept: the guard only drops what it can
 * attribute to another language.
 */

type Script = 'latin' | 'cyrillic' | 'greek' | 'arabic' | 'hebrew' | 'cjk' | 'devanagari' | 'thai';

const SCRIPT_RANGES: [Script, RegExp][] = [
  ['latin', /[a-zA-Z\u00C0-\u024F]/],
  ['cyrillic', /[\u0400-\u04FF]/],
  ['greek', /[\u0370-\u03FF]/],
  ['arabic', /[\u0600-\u06FF]/],
  ['hebrew', /[\u0590-\u05FF]/],
  ['cjk', /[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/],
  ['devanagari', /[\u0900-\u097F]/],
  ['thai', /[\u0E00-\u0E7F]/],
];

const LANGUAGE_SCRIPT: Record<string, Script> = {
  fr: 'latin', en: 'latin', es: 'latin', de: 'latin', it: 'latin', pt: 'latin', nl: 'latin',
  ca: 'latin', pl: 'latin', ro: 'latin', sv: 'latin', da: 'latin', no: 'latin', fi: 'latin',
  ru: 'cyrillic', uk: 'cyrillic', bg: 'cyrillic', sr: 'cyrillic',
  el: 'greek', ar: 'arabic', fa: 'arabic', he: 'hebrew',
  ja: 'cjk', zh: 'cjk', ko: 'cjk', hi: 'devanagari', th: 'thai',
};

interface Markers { words: Set<string>; chars: RegExp | null }

const words = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

const MARKERS: Record<string, Markers> = {
  fr: {
    words: words(`le la les un une des du de et est sont que qui quoi pas ne je tu il elle on nous vous ils elles
      c'est j'ai d'accord oui ouais non mais ou donc avec pour dans sur au aux ce cette ces ça alors voilà bon bah
      euh très bien merci me te se mon ma mes ton ta son sa leur y en fait faire peut comme aussi tout être avoir`),
    chars: /[éèêëàâçùûîïôœ]/g,
  },
  en: {
    words: words(`the a an and is are was were you i it this that what of to in with for so let's let we they he she
      yes yeah okay but do don't have be just like right think know going gonna there here my your our`),
    chars: null,
  },
  es: {
    words: words(`el los las y es está están estoy que de en por para con sí pero muy bien él yo tú usted qué cómo
      pues bueno vale eso esto hay tengo tiene vamos nosotros ellos también`),
    chars: /[áíóúñ¿¡]/g,
  },
  de: {
    words: words(`der die das und ist nicht ich du er sie wir ihr ein eine mit für auf zu ja nein aber auch wie was
      gut genau also noch schon`),
    chars: /[äöüß]/g,
  },
  it: {
    words: words(`il lo gli e è che di non sono per con una ma anche come cosa bene sì questo quello allora perché`),
    chars: /[ìò]/g,
  },
  pt: {
    words: words(`o os as e é não que de em um uma com para por mas muito bem sim você eu ele ela isso então`),
    chars: /[ãõ]/g,
  },
};

function scriptOf(ch: string): Script | null {
  for (const [script, re] of SCRIPT_RANGES) if (re.test(ch)) return script;
  return null;
}

/** Marker words of `lang` among `tokens` (minus `exclude`), plus its marker diacritics in every token
 *  that is not `exclude`d itself — "él" is a Spanish word, so its "é" is not French evidence. */
function markerScore(lang: string, tokens: string[], exclude: Set<string>): number {
  const m = MARKERS[lang];
  if (!m) return 0;
  let score = 0;
  for (const t of tokens) {
    if (exclude.has(t)) continue;
    if (m.words.has(t)) score++;
    if (m.chars) score += (t.match(m.chars) || []).length;
  }
  return score;
}

/** True when `text` is attributable to a language other than the forced `language`. */
export function isForeignToLanguage(text: string, language: string): boolean {
  const lang = language.toLowerCase().split(/[-_]/)[0];
  const expected = LANGUAGE_SCRIPT[lang];
  if (!expected || !text.trim()) return false;

  // Script check: most letters outside the expected script.
  let letters = 0;
  let inScript = 0;
  for (const ch of text) {
    const s = scriptOf(ch);
    if (!s) continue;
    letters++;
    if (s === expected) inScript++;
  }
  if (letters > 0 && inScript * 2 < letters) return true;

  // Marker check (Latin-script languages with a marker set).
  if (expected !== 'latin' || !MARKERS[lang]) return false;
  const tokens = text.toLowerCase().replace(/[’]/g, "'").split(/[^\p{L}']+/u).filter(Boolean);
  const own = MARKERS[lang].words;
  for (const other of Object.keys(MARKERS)) {
    if (other === lang) continue;
    const theirs = MARKERS[other].words;
    // Words both languages share ("la", "de", "me") are evidence for neither; a word that belongs
    // to only one of them carries its diacritics with it.
    const shared = new Set([...own].filter(w => theirs.has(w)));
    const theirsOnly = new Set([...theirs].filter(w => !own.has(w)));
    const ownOnly = new Set([...own].filter(w => !theirs.has(w)));
    const ownScore = markerScore(lang, tokens, new Set([...shared, ...theirsOnly]));
    const theirScore = markerScore(other, tokens, new Set([...shared, ...ownOnly]));
    if (theirScore > ownScore) return true;
  }
  return false;
}
