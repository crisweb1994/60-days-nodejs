// Day 02 - 练习 1：模块化工具库 — 字符串工具（ESM）

export function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export function truncate(str, length) {
  if (str.length <= length) return str;
  return str.slice(0, length) + '...';
}

export function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[\s\W]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
