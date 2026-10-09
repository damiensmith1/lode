const items = [];

module.exports = {
  push(item) {
    items.push(item);
  },
  all() {
    return items;
  },
};
