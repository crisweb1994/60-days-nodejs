// Day 02 - 练习 1：模块化工具库 — 统一导出（CJS）

const string = require('./string');
const array = require('./array');
const date = require('./date');

module.exports = { ...string, ...array, ...date };
