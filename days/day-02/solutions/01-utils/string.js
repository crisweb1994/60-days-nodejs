// Day 02 - 练习 1：模块化工具库 — 字符串工具（CJS）

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function truncate(str, length) {
  if (str.length <= length) return str;
  return str.slice(0, length) + '...';
}

function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[\s\W]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { capitalize, truncate, slugify };
