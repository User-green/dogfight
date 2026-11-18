import { Kind } from '../sim/entity.js';

/**
 * Returns draw(ctx, entity). Uses the loaded sprite sheet when available,
 * otherwise falls back to the entity's own vector render() from Lab 2.
 */
export function createSpriteDrawer(sheet, frames) {
  if (!sheet) return (ctx, e) => e.render(ctx);

  function blit(ctx, name, x, y, size, angle, alpha = 1) {
    const [sx, sy, sw, sh] = frames[name];
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalAlpha = alpha;
    ctx.drawImage(sheet, sx, sy, sw, sh, -size / 2, -size / 2, size, size); // source rect -> dest rect
    ctx.restore();
  }

  return (ctx, e) => {
    switch (e.kind) {
      case Kind.SHIP: {
        if (!e.alive) return;
        const blink = e.invulnTimer > 0 && Math.floor(e.invulnTimer * 10) % 2 === 0;
        blit(ctx, e.isThrusting ? 'shipThrust' : 'ship', e.pos.x, e.pos.y, 128 * 0.47, e.angle, blink ? 0.35 : 1);
        return;
      }
      case Kind.BULLET:
        return blit(ctx, 'bullet', e.pos.x, e.pos.y, e.radius * 4, 0);
      case Kind.ASTEROID:
        // sprite is 128px with a ~52px radius shape: scale so the shape matches e.radius
        return blit(ctx, `asteroid${e.id % 3}`, e.pos.x, e.pos.y, (e.radius / 52) * 128, e.angle);
      case Kind.PICKUP:
        return blit(ctx, e.type === 'SHIELD' ? 'pickupShield' : 'pickupRapid', e.pos.x, e.pos.y, 40, e.angle);
      default:
        return e.render(ctx); // explosions stay procedural particles
    }
  };
}
