#!/usr/bin/env node
// Oblique Strategies, by Brian Eno and Peter Schmidt (1975 and later
// editions): draw a card, or several, at random.
//
//   node tools/oblique.mjs        one card
//   node tools/oblique.mjs 3      three different cards
//
// This is a selection from the deck, not the whole of it: the editions
// differ, and the deck is Eno and Schmidt's published work.

import { randomInt } from 'node:crypto';

const cards = [
  'Honour thy error as a hidden intention',
  'Use an old idea',
  'State the problem in words as clearly as possible',
  'Only one element of each kind',
  'What would your closest friend do?',
  'What to increase? What to reduce?',
  'Are there sections? Consider transitions',
  'Work at a different speed',
  'Emphasize the flaws',
  'Remove specifics and convert to ambiguities',
  'What is the reality of the situation?',
  'Simple subtraction',
  'Go slowly all the way round the outside',
  'Balance the consistency principle with the inconsistency principle',
  'Listen to the quiet voice',
  'Is it finished?',
  'Give the game away',
  'Abandon normal instruments',
  'Use fewer notes',
  'Repetition is a form of change',
  'Reverse',
  'Trust in the you of now',
  'What wouldn\'t you do?',
  'Emphasize differences',
  'Turn it upside down',
  'Discard an axiom',
  'Do nothing for as long as possible',
  'Water',
  'Make a blank valuable by putting it in an exquisite frame',
  'You can only make one dot at a time',
  'Infinitesimal gradations',
  'Accretion',
  'Take away the elements in order of apparent non-importance',
  'Mechanicalize something idiosyncratic',
  'Faced with a choice, do both',
  'A line has two sides',
  'Into the impossible',
  'Towards the insignificant',
  'Look at the order in which you do things',
  'Not building a wall but making a brick',
  'The most important thing is the thing most easily forgotten',
  'Don\'t be afraid of things because they\'re easy to do',
  'Question the heroic approach',
  'Cut a vital connection',
  'Humanize something free of error',
  'Bridges: build, burn',
  'Once the search is in progress, something will be found',
  'Only a part, not the whole',
  'From nothing to more than nothing',
  'Retrace your steps',
  'Look at a very small object, look at its centre',
  'Use filters',
  'Discover the recipes you are using and abandon them',
  'Change nothing and continue with immaculate consistency',
];

// n different cards: a partial Fisher-Yates shuffle, drawn from the
// system's source of randomness.
function draw(n) {
  const deck = [...cards];
  const hand = [];
  for (let i = 0; i < Math.min(n, deck.length); i++) {
    const j = i + randomInt(deck.length - i);
    [deck[i], deck[j]] = [deck[j], deck[i]];
    hand.push(deck[i]);
  }
  return hand;
}

const n = Number.parseInt(process.argv[2] ?? '1', 10);
if (!Number.isInteger(n) || n < 1) {
  console.error('usage: node tools/oblique.mjs [how many cards]');
  process.exit(1);
}
for (const card of draw(n)) console.log(card);
