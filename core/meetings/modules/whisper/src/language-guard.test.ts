/**
 * Forced-language guard golden — pins isForeignToLanguage on the hallucinations a backend that
 * ignores `language` returned in a French meeting, and on the French it must keep.
 * Run: npx tsx src/language-guard.test.ts
 */
import { isForeignToLanguage } from "./index.js";

let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failed++;
};

// Dropped in a French meeting (observed live with Voxtral, language=fr)
check("Cyrillic dropped", isForeignToLanguage("Ну да.", "fr"));
check("Cyrillic sentence dropped", isForeignToLanguage("Уже решила план.", "fr"));
check("Spanish dropped", isForeignToLanguage("Mamá él me apela.", "fr"));
check("English dropped", isForeignToLanguage("So let's", "fr"));
check("English sentence dropped", isForeignToLanguage("Hello everyone, today we will review the deployment and the pull request.", "fr"));

// Kept in a French meeting
check("French kept", !isForeignToLanguage("On regarde le déploiement et la pull request.", "fr"));
check("French with English jargon kept", !isForeignToLanguage("Je fais le merge de la feature sur staging.", "fr"));
check("short French kept", !isForeignToLanguage("Oui, d'accord.", "fr"));
check("marker-free text kept", !isForeignToLanguage("Teetsh, LSU.", "fr"));
check("OK kept", !isForeignToLanguage("OK.", "fr"));
check("tie kept", !isForeignToLanguage("Oui, the meeting.", "fr"));

// Other forced languages
check("French dropped in an English meeting", isForeignToLanguage("Je suis très content de vous voir.", "en"));
check("English kept in an English meeting", !isForeignToLanguage("So let's start the meeting.", "en"));
check("Russian kept in a Russian meeting", !isForeignToLanguage("Ну да.", "ru"));
check("Latin text dropped in a Russian meeting", isForeignToLanguage("Hello everyone.", "ru"));
check("unknown language: never drops", !isForeignToLanguage("Ну да.", "xx"));

if (failed) { console.error(`\n❌ language-guard: ${failed} checks FAILED.`); process.exit(1); }
console.log(`\n✅ language-guard: foreign windows dropped, the forced language kept.`);
