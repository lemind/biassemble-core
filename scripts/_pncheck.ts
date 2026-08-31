import { properNounWords } from "../src/orchestrators/grounnel/gates-shared";
const cases = [
  "Researchers attribute the difference in light absorption to strong atmospheric winds.",
  "One product line revenue was later restated as roughly $23.4 billion.",
  "Terminators are boundary regions that separate the planet's dayside from its nightside.",
  "The Wright brothers made four flights on December 17, 1903.",
  "Germany surrendered in 1945.",
  "Microsoft did not create the iPhone.",
  "Apple's iPad revenue was $6.2 billion in the fourth quarter.",
  "Historical computer mice were connected to computers by cables.",
];
for (const c of cases) console.log(JSON.stringify([...properNounWords(c)]).padEnd(34), "<-", c.slice(0, 60));
