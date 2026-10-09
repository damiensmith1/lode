const { add, double } = require("./lib/math");
const store = require("./lib/store");

function run() {
  const x = double(add(1, 2));
  store.push(x);
  return store.all();
}

module.exports = { run };
