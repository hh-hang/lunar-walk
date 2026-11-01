import test from 'node:test';
import assert from 'node:assert/strict';
import { craterRadius } from '../../src/terrain/craters.js';
import { heightAt, nearReliefAt, randomAt } from '../../src/terrain/height.js';

test('小坑数量随尺寸增大迅速减少，连续半径不会集中在几个固定值', () => {
  const radii = Array.from({ length: 20000 }, (_, i) => craterRadius(1, 64, (i + 0.5) / 20000));
  assert.ok(radii[0] >= 1 && radii.at(-1) <= 64);
  assert.equal(new Set(radii).size, radii.length);
  for (const radius of [2, 4, 8]) {
    const small = radii.filter((value) => value >= radius).length;
    const large = radii.filter((value) => value >= radius * 2).length;
    assert.ok(small / large > 3.8 && small / large < 4.3, '半径翻倍后累计坑数应接近原来的四分之一');
  }
});

test('小坑沿任一方向移动 48 米都不会重复原来的高度纹样', () => {
  const count = 1024;
  for (const [dx, dz] of [[48, 0], [0, 48], [-48, -48]]) {
    let sumA = 0, sumB = 0, squareA = 0, squareB = 0, product = 0;
    for (let i = 0; i < count; i++) {
      const x = (randomAt(i, 0, 31) - 0.5) * 192;
      const z = (randomAt(i, 0, 32) - 0.5) * 192;
      const a = nearReliefAt(x, z), b = nearReliefAt(x + dx, z + dz);
      sumA += a; sumB += b;
      squareA += a * a; squareB += b * b; product += a * b;
    }
    const correlation = (product - sumA * sumB / count) /
      Math.sqrt((squareA - sumA ** 2 / count) * (squareB - sumB ** 2 / count));
    assert.ok(Math.abs(correlation) < 0.3, `偏移 ${dx},${dz} 后高度不能保持周期相关`);
  }
});

test('全部陨石坑空间目录边界连续，远处与负坐标也不会出现高度断层', () => {
  for (const spacing of [0.8, 2, 6, 16, 48, 192, 1400])
    for (const cell of [-701, -1, 0, 1, 713]) {
      const boundary = cell * spacing;
      for (const offset of [-0.37, 0, 0.61]) {
        const other = boundary * 0.53 + offset;
        assert.ok(Math.abs(heightAt(boundary - 1e-6, other) - heightAt(boundary + 1e-6, other)) < 1e-4);
        assert.ok(Math.abs(heightAt(other, boundary - 1e-6) - heightAt(other, boundary + 1e-6)) < 1e-4);
      }
    }
});

test('探索远处并淘汰空间目录缓存后，返回原地的高度保持不变', () => {
  const points = [[-17.31, 26.83], [0, 0], [192.17, -48.29]];
  const before = points.map(([x, z]) => heightAt(x, z));
  for (let i = 0; i < 4500; i++) nearReliefAt(i * 19.37, -i * 23.19);
  assert.deepEqual(points.map(([x, z]) => heightAt(x, z)), before);
});
