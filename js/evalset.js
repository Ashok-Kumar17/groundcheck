// Hand-labelled benchmark. Every TRUE claim is stated in the Edgepedia article's summary;
// every FALSE claim is the same fact with one planted error (year, number, person, place or order),
// the kinds of mistakes LLMs actually make.
export const EVALSET = [
  ["The Eiffel Tower was built for the 1889 World's Fair.", ["Eiffel Tower"], true],
  ["The Eiffel Tower was built for the 1900 World's Fair.", ["Eiffel Tower"], false],
  ["The Taj Mahal was built by Shah Jahan in memory of his wife Mumtaz Mahal.", ["Taj Mahal", "Shah Jahan"], true],
  ["The Taj Mahal was built by Akbar in memory of his wife.", ["Taj Mahal", "Akbar"], false],
  ["Chandrayaan-3 made India the fourth country to soft-land on the Moon.", ["Chandrayaan-3"], true],
  ["Chandrayaan-3 made India the third country to soft-land on the Moon.", ["Chandrayaan-3"], false],
  ["IIT Madras was founded in 1959 with West German aid.", ["IIT Madras"], true],
  ["IIT Madras was founded in 1961 with Soviet aid.", ["IIT Madras"], false],
  ["Mount Everest was first climbed on 29 May 1953 by Hillary and Tenzing Norgay.", ["Mount Everest"], true],
  ["Mount Everest was first climbed in 1950 by Hillary and Tenzing Norgay.", ["Mount Everest"], false],
  ["Isaac Newton published the Principia Mathematica in 1687.", ["Isaac Newton"], true],
  ["Isaac Newton published the Principia Mathematica in 1705.", ["Isaac Newton"], false],
  ["Marie Curie discovered polonium and radium.", ["Marie Curie"], true],
  ["Marie Curie won Nobel Prizes in 1903 and 1921.", ["Marie Curie"], false],
  ["During Apollo 11, Michael Collins orbited the Moon while Neil Armstrong and Buzz Aldrin landed.", ["Apollo 11"], true],
  ["During Apollo 11, Buzz Aldrin stayed in orbit while Neil Armstrong and Michael Collins landed on the Moon.", ["Apollo 11"], false],
  ["Srinivasa Ramanujan collaborated with G. H. Hardy at Cambridge.", ["Srinivasa Ramanujan"], true],
  ["Srinivasa Ramanujan collaborated with G. H. Hardy at Oxford.", ["Srinivasa Ramanujan"], false],
  ["The Statue of Liberty was dedicated on October 28, 1886.", ["Statue of Liberty"], true],
  ["The Statue of Liberty was a gift from Britain to the United States.", ["Statue of Liberty"], false],
  ["C. V. Raman won the Nobel Prize in Physics in 1930.", ["C. V. Raman"], true],
  ["C. V. Raman discovered the Raman effect in 1938.", ["C. V. Raman"], false],
  ["ISRO is headquartered in Bengaluru.", ["ISRO"], true],
  ["ISRO was founded in 1975.", ["ISRO"], false],
  ["The Burj Khalifa is 828 meters tall.", ["Burj Khalifa"], true],
  ["The Burj Khalifa has been the tallest building in the world since it opened in 2004.", ["Burj Khalifa"], false],
  ["Python was created by Guido van Rossum.", ["Python (programming language)"], true],
  ["Python was first released in 2000.", ["Python (programming language)"], false],
  ["The Titanic sank in April 1912 after striking an iceberg.", ["Titanic"], true],
  ["The Titanic was an ocean liner of the Cunard Line.", ["Titanic"], false],
  ["Penicillin was discovered by Fleming in 1928.", ["Penicillin"], true],
  ["Penicillin was discovered by Louis Pasteur in 1928.", ["Penicillin", "Louis Pasteur"], false],
  ["Charles Darwin published On the Origin of Species in 1859.", ["Charles Darwin"], true],
  ["Charles Darwin announced natural selection jointly with Gregor Mendel.", ["Charles Darwin"], false],
  ["The Mona Lisa is a portrait of Lisa Gherardini.", ["Mona Lisa"], true],
  ["The Mona Lisa is a portrait of Isabella d'Este.", ["Mona Lisa"], false],
  ["The Great Wall of China was listed by UNESCO in 1987.", ["Great Wall of China"], true],
  ["The Great Wall of China was mainly rebuilt by the Han dynasty.", ["Great Wall of China"], false],
  ["Mahatma Gandhi developed satyagraha in South Africa.", ["Mahatma Gandhi"], true],
  ["Mahatma Gandhi developed satyagraha in Kenya.", ["Mahatma Gandhi"], false],
].map(([claim, entities, label], id) => ({ id, claim, entities, label }));

// Score: what matters most is never calling a false claim "supported".
export function scoreEval(rows) {
  const t = rows.filter(r => r.label), f = rows.filter(r => !r.label);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const m = {
    n: rows.length,
    trueSupported: t.filter(r => r.status === "SUPPORTED").length,
    trueFlagged: t.filter(r => r.status === "CONTRADICTED").length,
    trueUnverified: t.filter(r => r.status === "UNVERIFIED").length,
    falseCaught: f.filter(r => r.status === "CONTRADICTED").length,
    falsePassed: f.filter(r => r.status === "SUPPORTED").length,
    falseUnverified: f.filter(r => r.status === "UNVERIFIED").length,
    guardCatches: rows.filter(r => r.guard).length,
    nTrue: t.length, nFalse: f.length,
  };
  m.accuracy = pct(m.trueSupported + m.falseCaught, rows.length);
  m.falseCaughtPct = pct(m.falseCaught, f.length);
  m.dangerousPct = pct(m.falsePassed, f.length); // false claim shown as green: the error that matters
  m.trueSupportedPct = pct(m.trueSupported, t.length);
  return m;
}
