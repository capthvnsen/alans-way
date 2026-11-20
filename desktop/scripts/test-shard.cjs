// Prints the unit test files for one CI shard: node scripts/test-shard.cjs <index 1..n> <n>.
// Longest-first onto the lightest shard, using seconds measured per file in
// test/shard-weights.json; a file with no recorded time counts as the median,
// so a new test lands somewhere reasonable until the weights are refreshed.
const fs = require('node:fs');
const path = require('node:path');

function shards(files, weights, total) {
  const known = Object.values(weights).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = (file) => weights[file] ?? median;
  const bins = Array.from({ length: total }, () => ({ load: 0, files: [] }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const bin = bins.reduce((best, candidate) => (candidate.load < best.load ? candidate : best));
    bin.files.push(file);
    bin.load += weight(file);
  }
  return bins.map((bin) => bin.files.sort());
}

function unitFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.test.cjs')).sort();
}

module.exports = { shards, unitFiles };

if (require.main === module) {
  const [index, total] = process.argv.slice(2).map(Number);
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
    console.error('usage: node scripts/test-shard.cjs <index 1..n> <n>');
    process.exit(2);
  }
  const testDir = path.join(__dirname, '..', 'test');
  const weights = JSON.parse(fs.readFileSync(path.join(testDir, 'shard-weights.json'), 'utf8'));
  console.log(shards(unitFiles(testDir), weights, total)[index - 1].map((name) => `test/${name}`).join(' '));
}
