function add(a, b) {
  return a + b;
}

exports.add = add;
exports.double = function (n) {
  return add(n, n);
};
module.exports.version = "1";
