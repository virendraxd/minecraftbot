// functions.js
const { Vec3 } = require('vec3');
const { GoalBlock, GoalNear } = require('mineflayer-pathfinder').goals;

let bot;
let mcData;

// Internal states
let lastPickUpTime = 0;
const pickUpCooldown = 500;
let isCancelled = false;

// -------------------------------------------------------
// SETUP
// -------------------------------------------------------
function setupActions(botInstance, mcDataInstance) {
  bot = botInstance;
  mcData = mcDataInstance;

  bot.loadPlugin(require('mineflayer-pathfinder').pathfinder);
}

// -------------------------------------------------------
// FIND NEAREST TRAPPED CHEST
// -------------------------------------------------------
function findNearestTrappedChest() {
  const chests = bot.findBlocks({
    matching: block => block.name === 'trapped_chest',
    maxDistance: 16,
    count: 1
  });

  if (!chests.length) return null;
  return bot.blockAt(chests[0]);
}

// -------------------------------------------------------
// LOG INVENTORY
// -------------------------------------------------------
function logInventory() {
  const items = bot.inventory.items()
    .map(item => `${item.count}x ${item.name}`)
    .join(', ');

  console.log(`Current Inventory: ${items}`);
}

// -------------------------------------------------------
// ROAM RANDOMLY
// -------------------------------------------------------
async function roamAround(radius = 10) {
  const dx = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
  const dz = Math.floor(Math.random() * (radius * 2 + 1)) - radius;

  const target = bot.entity.position.offset(dx, 0, dz);

  try {
    await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, 1));
  } catch (err) {
    console.log(`❌ Roaming failed: ${err.message}`);
  }
}

// -------------------------------------------------------
// MINE BLOCK
// -------------------------------------------------------
async function mineBlock(pos) {
  const targetBlock = bot.blockAt(pos);
  if (!targetBlock) return;

  if (!bot.canDigBlock(targetBlock)) return;

  try {
    await bot.pathfinder.goto(new GoalBlock(pos.x, pos.y + 1, pos.z));
    await bot.dig(targetBlock);
  } catch (err) {
    console.log(`❌ Mining failed: ${err.message}`);
  }
}

// -------------------------------------------------------
// AXE CHECK
// -------------------------------------------------------
function hasAxe() {
  const tools = ['stone_axe', 'golden_axe', 'iron_axe', 'diamond_axe', 'netherite_axe'];
  return bot.inventory.items().some(item => tools.includes(item.name));
}

// -------------------------------------------------------
// EQUIP AXE
// -------------------------------------------------------
async function equipAxe() {
  const tools = ['stone_axe', 'golden_axe', 'iron_axe', 'diamond_axe', 'netherite_axe'];
  const axe = bot.inventory.items().find(item => tools.includes(item.name));

  if (axe) {
    try {
      await bot.equip(axe, 'hand');
      console.log(`🪓 Equipped ${axe.name}`);
    } catch (err) {
      console.log('❌ Failed to equip axe:', err);
    }
  }
}

// -------------------------------------------------------
// COLLECT WOOD
// -------------------------------------------------------
async function collectWood(targetCount = 64) {
  await equipAxe();

  const minedPositions = new Set();
  const MAX_SKIP = 10;

  async function loop() {
    if (isCancelled) return;

    await collectNearbyDrops();

    // log ids
    const logItemNames = Object.keys(mcData.itemsByName)
      .filter(name => name.endsWith('_log') && !name.includes('stripped'));

    const logIDs = logItemNames.map(name => mcData.itemsByName[name].id);

    const currentLogCount = bot.inventory.items()
      .filter(item => logIDs.includes(item.type))
      .reduce((sum, item) => sum + item.count, 0);

    if (currentLogCount >= targetCount) {
      bot.chat(`✅ Collected ${currentLogCount} logs.`);
      return;
    }

    // find logs
    const logBlockIDs = Object.keys(mcData.blocksByName)
      .filter(name => name.endsWith('_log') && !name.includes('stripped'))
      .map(name => mcData.blocksByName[name].id);

    const targets = bot.findBlocks({
      matching: logBlockIDs,
      maxDistance: 32,
      count: 32
    });

    if (targets.length === 0) {
      await roamAround(15);
      return setTimeout(loop, 1000);
    }

    let skipCounter = 0;

    for (const pos of targets) {
      const key = pos.toString();
      if (minedPositions.has(key)) continue;

      const block = bot.blockAt(pos);
      if (!block || block.name.includes('leaves') || !bot.canDigBlock(block)) {
        skipCounter++;
        if (skipCounter >= MAX_SKIP) {
          await roamAround(10);
          break;
        }
        continue;
      }

      minedPositions.add(key);

      try {
        await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 1));
        await mineBlock(pos);
      } catch {}

      break;
    }

    setTimeout(loop, 500);
  }

  loop();
}

// -------------------------------------------------------
// PICK UP DROPS
// -------------------------------------------------------
async function collectNearbyDrops() {
  const now = Date.now();
  if (now - lastPickUpTime < pickUpCooldown) return;

  const items = Object.values(bot.entities)
    .filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 5);

  for (const item of items) {
    try {
      await bot.pathfinder.goto(new GoalNear(item.position.x, item.position.y, item.position.z, 1));
      await bot.pickUp(item);
      lastPickUpTime = now;
    } catch {}
  }
}

// -------------------------------------------------------
// DEPOSIT LOGS
// -------------------------------------------------------
async function depositToChest() {
  const chestBlock = bot.findBlock({
    matching: mcData.blocksByName.chest.id,
    maxDistance: 10
  });

  if (!chestBlock) return bot.chat("❌ No chest nearby.");

  try {
    await bot.pathfinder.goto(new GoalNear(
      chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 1
    ));

    const chest = await bot.openChest(chestBlock);
    const logs = bot.inventory.items().filter(i => i.name.includes('log'));

    for (const log of logs) {
      await chest.deposit(log.type, null, log.count);
    }

    await chest.close();
    bot.chat("📦 Logs deposited.");
  } catch (err) {
    console.log("❌ Deposit error:", err);
  }
}

// -------------------------------------------------------
// RAYTRACE
// -------------------------------------------------------
function directionToVector(dir) {
  if (dir > 5 || dir < 0) return null;
  const faces = [
    new Vec3(0, -1, 0),
    new Vec3(0, 1, 0),
    new Vec3(0, 0, -1),
    new Vec3(0, 0, 1),
    new Vec3(-1, 0, 0),
    new Vec3(1, 0, 0)
  ];
  return faces[dir];
}

function rayTraceEntitySight(entity) {
  const { height, position, yaw, pitch } = entity;

  const dir = new Vec3(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch)
  );

  return bot.world.raycast(position.offset(0, height, 0), dir, 120);
}

// -------------------------------------------------------
// EXPORT ALL ACTIONS
// -------------------------------------------------------
module.exports = {
  setupActions,
  findNearestTrappedChest,
  logInventory,
  roamAround,
  mineBlock,
  hasAxe,
  equipAxe,
  collectWood,
  collectNearbyDrops,
  depositToChest,
  directionToVector,
  rayTraceEntitySight
};
