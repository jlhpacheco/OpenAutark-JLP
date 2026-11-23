// Number words (B-041): the one number-word table of durations and clock times (DE/EN, folded – shared/text/normalize.ts
// foldText) that the time finder (shared/text/when.ts) reads, so "in zehn Minuten" and "um neun" mean the same everywhere.
// Owns: the table. Never: a clock, or a reading of its own.

/** Number words of durations and clock times (folded DE/EN; no articles – "a"/"ein" mean one only where a reader says so). */
export const NUMBER_WORDS: Readonly<Record<string, number>> = {
  eins: 1, one: 1, zwei: 2, two: 2, drei: 3, three: 3, vier: 4, four: 4, funf: 5, five: 5, sechs: 6, six: 6, sieben: 7, seven: 7,
  acht: 8, eight: 8, neun: 9, nine: 9, zehn: 10, ten: 10, elf: 11, eleven: 11, zwolf: 12, twelve: 12, funfzehn: 15, fifteen: 15,
  zwanzig: 20, twenty: 20, funfundzwanzig: 25, 'twenty-five': 25, dreissig: 30, thirty: 30, vierzig: 40, forty: 40,
  funfundvierzig: 45, 'forty-five': 45, sechzig: 60, sixty: 60, neunzig: 90, ninety: 90,
};
