import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aisleFor, aisleOrder } from '../src/aisles.js';

test('sorts products into the same aisles at every shop', () => {
  const cases = [
    [{ name: 'Woolworths Full Cream Milk 2L', category: 'Milk' }, 'dairy'],
    [{ name: 'Coles Full Cream Milk', category: 'Dairy, Eggs & Fridge' }, 'dairy'],
    [{ name: 'Bananas', category: 'Fruits & Vegetables' }, 'produce'],
    [{ name: 'Birds Eye Frozen Peas 1kg', category: 'Vegetables' }, 'frozen'],
    [{ name: 'Pedigree Dog Food Beef 1.2kg' }, 'pet'],
    [{ name: 'Heinz Tomato Sauce 500ml' }, 'pantry'],
    [{ name: 'Smiths Potato Chips Original 170g' }, 'snacks'],
    [{ name: 'Arnott\'s Water Crackers' }, 'snacks'],
    [{ name: 'Bega Peanut Butter Smooth' }, 'pantry'],
    [{ name: 'Coca-Cola Classic 1.25L' }, 'drinks'],
    [{ name: 'Tip Top Wholemeal Bread 700g' }, 'bakery'],
    [{ name: 'Chicken Breast Fillets', category: 'Meat & Seafood' }, 'meat'],
    [{ name: 'Mystery thing' }, 'other'],
  ];
  for (const [p, want] of cases) assert.equal(aisleFor(p), want, p.name);
  assert.ok(aisleOrder('produce') < aisleOrder('frozen'), 'fruit & veg before frozen');
  assert.equal(aisleOrder('nonsense'), aisleOrder('other'));
});
