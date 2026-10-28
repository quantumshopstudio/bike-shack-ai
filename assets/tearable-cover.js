/*
  <tearable-cover> — full-screen tearable cloth over the gift card page.
  Feature docs: .claude/features/tearable-cover/ (spec, implementation plan, QA log).

  A Verlet cloth grid (ClothSimulation, below) rendered with three.js. Mouse/touch drags
  push the cloth, and sticks over-stretched along the pointer's path tear. Lambert
  lighting gives folds depth, and the cloth's reverse side shows where it folds over.
  Customizer effects: wind (gentle billow, eased in), cursor ripples, and "falls". Once
  65% of the screen is uncovered (or on Reveal / Escape) the rest falls away or fades,
  then everything is torn down. Untouched and windless, it matches the static picture
  exactly.

  The static picture is the permanent fallback: reduced motion, no WebGL2, a failed
  three.js/texture load, any error, or a device too slow in the first 2 s (untouched
  cloth only) leave it in place, fully usable.

  Resizing: an untouched cloth is rebuilt for the new size; a torn one stretches for
  small changes and clears itself on big shape changes (e.g. rotating a phone).

  - "Show once": remembered per gift card in localStorage (key built in Liquid).
  - While open: page scroll locked, everything else in <body> is inert, focus on Reveal.
  - Reveal button or Escape: fade out, unlock, focus the page's main heading.
  - Theme editor: always shows, never steals focus from the editor, never stores.
  - three.js (assets/three.module.js) is imported lazily, only when the cloth will run.
*/
if (!customElements.get('tearable-cover')) {
  // Cloth self-shadowing (folds cast shadows on the cloth behind them). One switch so it
  // can be turned off if it causes artifacts or costs too much on phones.
  const CLOTH_SHADOWS = true;

  // Auto-clear once this share of the screen is no longer covered by attached cloth
  // (client decision: 60–70%).
  const AUTO_CLEAR_SHARE = 0.65;

  /*
    Verlet cloth: a grid of points joined by "sticks" (distance constraints).
    Each point keeps its current and previous position; velocity is implied by the
    difference, so the simulation is stable and cheap. Sticks are relaxed a few times per
    step to hold their rest length. Pinned points (the off-screen border) never move.

    World units: the viewport is 2 units tall; the cloth overhangs every edge by a margin
    so its pinned border is never visible.
  */
  class ClothSimulation {
    constructor({ width, height, columns, rows, cellSizePx = 16, viewWidth = width, viewHeight = height }) {
      this.columns = columns;
      this.rows = rows;
      this.width = width;
      this.height = height;

      // Tuning (adjusted by eye during QA).
      this.damping = 0.985; // velocity kept per step
      this.iterations = 4; // stick relaxation passes per step
      // Gravity (world units / s²) stays off until the first tear: a cloth hanging under its
      // own weight sags a few pixels, and the untouched cloth must match the picture exactly.
      this.gravity = 0;
      this.fullGravity = -3.2; // a pinch gentler than first tried (-4), per QA
      // The cloth hangs over the page like paper on a wall: torn flaps should peel off the
      // wall toward the viewer, not slide down flat inside the cloth's own plane. A small
      // pull toward the viewer (a share of gravity) does that; the page acts as a wall the
      // cloth can't pass behind (z ≥ 0).
      this.peelShare = 0.2;
      this.peelDepth = 0.35; // the pull fades to zero this far off the page (then flaps just fall)

      // Wind (customizer toggle): a gentle force that varies over time and across the
      // cloth, mostly toward the viewer. Kept subtle so the headline doesn't swim (sim: 0.08
      // gave a ~3% billow, ~3px shift on desktop); loose flaps flutter more.
      this.windEnabled = false;
      this.windStrength = 0.092; // 0.08 + 15%, per QA (2026-10-24)
      this.windTime = 0;
      this.windRamp = 0; // eases the wind in over ~2 s so the picture → canvas swap stays invisible

      // Cursor ripples (customizer toggle): pointer movement lifts the cloth around it.
      this.rippleStrength = 2.5; // lift per unit of pointer movement (sim: ~4% bump on desktop hover)
      this.rippleRadiusCells = 3;
      this.pendingRipple = null; // set by ripple(), applied on the next step

      // Tearing depends on how many cells the pointer crosses per frame, and cells are
      // bigger on desktop (~31px) than on phones (~13px). Scaling the drag by cell size
      // makes the same swipe speed feel the same everywhere: tuned so drags under
      // ~300 px/s only stretch and swipes from ~600 px/s tear, on desktop and phone.
      this.dragStrength = 1.8 * (cellSizePx / 16); // push along the pointer's movement
      this.grabRadiusCells = 2.2; // drag influence radius, in grid cells
      this.tearFactor = 1.8; // near the visitor's recent pointer path: snaps past this × rest length
      // Everywhere else the cloth stretches but holds unless pulled far harder. Without
      // this, gravity concentrates strain at the tip of a cut and the crack runs the whole
      // height of the cloth (QA: a small downward flick on a phone collapsed everything).
      this.passiveTearFactor = 3;
      this.tearTrail = []; // recent pointer positions: { x, y, age } (see drag())
      this.tearTrailLifetime = 0.25; // seconds a path keeps tearing after the pointer passes
      this.tearRadiusCells = 4; // how close to that path a stick must be to tear

      this.cellSize = width / columns;
      this.pendingDrag = null; // set by drag(), applied on the next step

      const pointCount = (columns + 1) * (rows + 1);
      this.pinned = new Uint8Array(pointCount); // the original border pins (inverseMass changes later)
      this.attached = new Uint8Array(pointCount); // still connected to a pin (see updateAttachment)
      this.viewHalfWidth = viewWidth / 2;
      this.viewHalfHeight = viewHeight / 2;
      this.positions = new Float32Array(pointCount * 3);
      this.previous = new Float32Array(pointCount * 3);
      this.restPositions = new Float32Array(pointCount * 3);
      this.inverseMass = new Float32Array(pointCount);

      const spacingX = width / columns;
      const spacingY = height / rows;
      for (let row = 0; row <= rows; row++) {
        for (let column = 0; column <= columns; column++) {
          const index = this.pointIndex(column, row);
          const x = -width / 2 + column * spacingX;
          const y = height / 2 - row * spacingY;
          this.positions.set([x, y, 0], index * 3);
          this.previous.set([x, y, 0], index * 3);
          this.restPositions.set([x, y, 0], index * 3);
          const onBorder = row === 0 || row === rows || column === 0 || column === columns;
          this.inverseMass[index] = onBorder ? 0 : 1;
          this.pinned[index] = onBorder ? 1 : 0;
        }
      }

      // Sticks: all horizontal ones first, then all vertical ones (see stick helpers).
      this.horizontalCount = (rows + 1) * columns;
      const stickCount = this.horizontalCount + rows * (columns + 1);
      this.stickA = new Uint32Array(stickCount);
      this.stickB = new Uint32Array(stickCount);
      this.restLength = new Float32Array(stickCount);
      this.broken = new Uint8Array(stickCount);

      for (let row = 0; row <= rows; row++) {
        for (let column = 0; column < columns; column++) {
          this.addStick(this.horizontalStick(column, row), this.pointIndex(column, row), this.pointIndex(column + 1, row));
        }
      }
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column <= columns; column++) {
          this.addStick(this.verticalStick(column, row), this.pointIndex(column, row), this.pointIndex(column, row + 1));
        }
      }

      this.tornCount = 0; // broken sticks so far; 0 = untouched (also read by the resize logic)
      this.topologyChanged = true; // the render index must be (re)built
      this.moved = true; // something moved since the last render
    }

    pointIndex(column, row) {
      return row * (this.columns + 1) + column;
    }

    horizontalStick(column, row) {
      return row * this.columns + column;
    }

    verticalStick(column, row) {
      return this.horizontalCount + row * (this.columns + 1) + column;
    }

    addStick(stick, a, b) {
      this.stickA[stick] = a;
      this.stickB[stick] = b;
      const dx = this.restPositions[b * 3] - this.restPositions[a * 3];
      const dy = this.restPositions[b * 3 + 1] - this.restPositions[a * 3 + 1];
      this.restLength[stick] = Math.hypot(dx, dy);
    }

    // A grid cell is drawn only while all four of its edges are intact.
    isCellIntact(column, row) {
      return (
        !this.broken[this.horizontalStick(column, row)] &&
        !this.broken[this.horizontalStick(column, row + 1)] &&
        !this.broken[this.verticalStick(column, row)] &&
        !this.broken[this.verticalStick(column + 1, row)]
      );
    }

    step(dt) {
      const { positions, previous, inverseMass, damping } = this;
      const gravityStep = this.gravity * dt * dt;
      const peelStep = -this.gravity * this.peelShare * dt * dt; // toward the viewer (+z)
      let maxMove = 0;

      // Age the tear trail; forget path points older than its lifetime.
      for (const point of this.tearTrail) point.age += dt;
      while (this.tearTrail.length && this.tearTrail[0].age > this.tearTrailLifetime) this.tearTrail.shift();

      // Wind: a slow gust envelope times two crossing waves, so the billow drifts across
      // the cloth instead of pulsing in place. Biased toward the viewer (the page is a wall).
      let gust = 0;
      if (this.windEnabled) {
        this.windTime += dt;
        this.windRamp = Math.min(1, this.windRamp + dt / 2);
        gust = this.windStrength * this.windRamp * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(this.windTime * 0.5)));
      }
      const t = this.windTime;
      const rest = this.restPositions;

      // Integrate: new = current + (current - previous) * damping + acceleration * dt².
      for (let index = 0; index < inverseMass.length; index++) {
        if (inverseMass[index] === 0) continue;
        const i = index * 3;

        let windX = 0;
        let windZ = 0;
        if (gust) {
          const wave =
            Math.sin(t * 1.6 + rest[i] * 1.8 + rest[i + 1] * 0.9) * 0.6 +
            Math.sin(t * 2.7 - rest[i] * 0.7 + rest[i + 1] * 2.3) * 0.4;
          windZ = gust * (0.6 + 0.4 * wave) * dt * dt;
          windX = gust * 0.1 * wave * dt * dt;
        }

        for (let axis = 0; axis < 3; axis++) {
          const current = positions[i + axis];
          let next = current + (current - previous[i + axis]) * damping;
          if (axis === 0) next += windX;
          if (axis === 1) next += gravityStep;
          if (axis === 2) next += peelStep * Math.max(0, 1 - current / this.peelDepth) + windZ;
          previous[i + axis] = current;
          positions[i + axis] = next;
          maxMove = Math.max(maxMove, Math.abs(next - current));
        }
      }

      if (this.pendingDrag) {
        this.applyDrag(this.pendingDrag);
        this.pendingDrag = null;
        maxMove = Math.max(maxMove, 1); // a drag always needs a redraw
      }

      if (this.pendingRipple) {
        this.applyRipple(this.pendingRipple);
        this.pendingRipple = null;
        maxMove = Math.max(maxMove, 1);
      }

      for (let pass = 0; pass < this.iterations; pass++) this.relaxSticks();
      this.keepInFrontOfPage();

      if (maxMove > 1e-6) this.moved = true;
    }

    // The page is a wall at z = 0: cloth can't pass behind it.
    keepInFrontOfPage() {
      const { positions, previous } = this;
      for (let i = 2; i < positions.length; i += 3) {
        if (positions[i] < 0) {
          positions[i] = 0;
          previous[i] = 0; // stop, don't bounce
        }
      }
    }

    // Queue a ripple: the pointer is at (x, y) and moved `distance` since the last step.
    ripple(x, y, distance) {
      if (this.pendingRipple) {
        this.pendingRipple.distance += distance;
        this.pendingRipple.x = x;
        this.pendingRipple.y = y;
      } else {
        this.pendingRipple = { x, y, distance };
      }
    }

    // Lift the cloth around the pointer, proportional to how far it moved (a resting
    // cursor makes no ripple). The lift spreads through the sticks and settles.
    applyRipple({ x, y, distance }) {
      const { positions, previous, inverseMass } = this;
      const radius = this.cellSize * this.rippleRadiusCells;
      const lift = Math.min(distance, radius) * this.rippleStrength;
      for (let index = 0; index < inverseMass.length; index++) {
        if (inverseMass[index] === 0) continue;
        const i = index * 3;
        const d = Math.hypot(positions[i] - x, positions[i + 1] - y);
        if (d >= radius) continue;
        previous[i + 2] -= lift * (1 - d / radius) ** 2 * 0.1; // velocity toward the viewer
      }
    }

    // Queue the pointer's movement since the last step (simulation coordinates).
    drag(x, y, dx, dy) {
      this.tearTrail.push({ x, y, age: 0 });
      if (this.pendingDrag) {
        this.pendingDrag.dx += dx;
        this.pendingDrag.dy += dy;
        this.pendingDrag.x = x;
        this.pendingDrag.y = y;
      } else {
        this.pendingDrag = { x, y, dx, dy };
      }
    }

    // Points near the pointer gain velocity along its movement, fading with distance.
    // Neighbours outside the radius hold back, so a fast drag over-stretches the sticks
    // in its path and they tear along it; a slow drag only stretches the cloth.
    applyDrag({ x, y, dx, dy }) {
      const { positions, previous, inverseMass } = this;
      const radius = this.cellSize * this.grabRadiusCells;
      for (let index = 0; index < inverseMass.length; index++) {
        if (inverseMass[index] === 0) continue;
        const i = index * 3;
        const distance = Math.hypot(positions[i] - x, positions[i + 1] - y);
        if (distance >= radius) continue;
        const weight = (1 - distance / radius) * this.dragStrength;
        previous[i] -= dx * weight;
        previous[i + 1] -= dy * weight;
      }
    }

    // Is (x, y) within the tear radius of the pointer's recent path (its segments)?
    isNearTearTrail(x, y) {
      const trail = this.tearTrail;
      if (!trail.length) return false;
      const radius = this.cellSize * this.tearRadiusCells;
      const radiusSquared = radius * radius;
      for (let k = 0; k < trail.length; k++) {
        const a = trail[k];
        const b = trail[k + 1] || a;
        const segmentX = b.x - a.x;
        const segmentY = b.y - a.y;
        const lengthSquared = segmentX * segmentX + segmentY * segmentY;
        const along = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * segmentX + (y - a.y) * segmentY) / lengthSquared)) : 0;
        const offX = x - (a.x + segmentX * along);
        const offY = y - (a.y + segmentY * along);
        if (offX * offX + offY * offY < radiusSquared) return true;
      }
      return false;
    }

    breakStick(stick) {
      this.broken[stick] = 1;
      if (this.tornCount === 0) this.gravity = this.fullGravity;
      this.tornCount++;
      this.topologyChanged = true;
    }

    relaxSticks() {
      const { positions, inverseMass, stickA, stickB, restLength, broken } = this;
      for (let stick = 0; stick < stickA.length; stick++) {
        if (broken[stick]) continue;
        const a = stickA[stick];
        const b = stickB[stick];
        const weightA = inverseMass[a];
        const weightB = inverseMass[b];
        const totalWeight = weightA + weightB;
        if (totalWeight === 0) continue;

        const ia = a * 3;
        const ib = b * 3;
        const dx = positions[ib] - positions[ia];
        const dy = positions[ib + 1] - positions[ia + 1];
        const dz = positions[ib + 2] - positions[ia + 2];
        const length = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
        if (length > restLength[stick] * this.tearFactor) {
          const nearPath = this.isNearTearTrail((positions[ia] + positions[ib]) / 2, (positions[ia + 1] + positions[ib + 1]) / 2);
          if (nearPath || length > restLength[stick] * this.passiveTearFactor) {
            this.breakStick(stick);
            continue;
          }
        }
        const correction = (length - restLength[stick]) / length / totalWeight;

        positions[ia] += dx * correction * weightA;
        positions[ia + 1] += dy * correction * weightA;
        positions[ia + 2] += dz * correction * weightA;
        positions[ib] -= dx * correction * weightB;
        positions[ib + 1] -= dy * correction * weightB;
        positions[ib + 2] -= dz * correction * weightB;
      }
    }

    // Flood-fill from the pins across intact sticks: whatever isn't reached has torn loose.
    // Loose points that have fallen below the screen are frozen (no more physics work).
    updateAttachment() {
      const { attached, pinned, columns, rows, positions, previous, inverseMass } = this;
      attached.fill(0);
      const queue = [];
      for (let index = 0; index < pinned.length; index++) {
        if (pinned[index] && inverseMass[index] === 0) {
          attached[index] = 1;
          queue.push(index);
        }
      }
      while (queue.length) {
        const index = queue.pop();
        const column = index % (columns + 1);
        const row = (index - column) / (columns + 1);
        const visit = (stick, neighbour) => {
          if (!this.broken[stick] && !attached[neighbour]) {
            attached[neighbour] = 1;
            queue.push(neighbour);
          }
        };
        if (column > 0) visit(this.horizontalStick(column - 1, row), index - 1);
        if (column < columns) visit(this.horizontalStick(column, row), index + 1);
        if (row > 0) visit(this.verticalStick(column, row - 1), index - (columns + 1));
        if (row < rows) visit(this.verticalStick(column, row), index + (columns + 1));
      }

      const offScreenY = -this.viewHalfHeight - 0.3;
      for (let index = 0; index < attached.length; index++) {
        if (attached[index] || inverseMass[index] === 0) continue;
        if (positions[index * 3 + 1] < offScreenY) {
          inverseMass[index] = 0;
          previous.set(positions.subarray(index * 3, index * 3 + 3), index * 3);
        }
      }
    }

    // Share of the SCREEN still covered by attached cloth (1 = untouched). Measured on a
    // coarse screen grid (squares two cells wide): each intact, attached cell marks the
    // squares under its corners and centre, projected with perspective. Counting cells
    // instead would treat folded, bunched-up flaps as if they still covered the page.
    coveredScreenShare(cameraDistance) {
      this.updateAttachment();
      const { positions, columns, rows, viewHalfWidth, viewHalfHeight } = this;
      const squareSize = this.cellSize * 2;
      const squaresX = Math.ceil((viewHalfWidth * 2) / squareSize);
      const squaresY = Math.ceil((viewHalfHeight * 2) / squareSize);
      const covered = new Uint8Array(squaresX * squaresY);
      let coveredCount = 0;

      const mark = (x, y, z) => {
        const scale = cameraDistance / (cameraDistance - Math.min(z, cameraDistance * 0.9));
        const squareX = Math.floor((x * scale + viewHalfWidth) / squareSize);
        const squareY = Math.floor((y * scale + viewHalfHeight) / squareSize);
        if (squareX < 0 || squareY < 0 || squareX >= squaresX || squareY >= squaresY) return;
        const square = squareY * squaresX + squareX;
        if (!covered[square]) {
          covered[square] = 1;
          coveredCount++;
        }
      };

      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          if (!this.isCellIntact(column, row) || !this.attached[this.pointIndex(column, row)]) continue;
          const corners = [
            this.pointIndex(column, row),
            this.pointIndex(column + 1, row),
            this.pointIndex(column, row + 1),
            this.pointIndex(column + 1, row + 1),
          ];
          let sumX = 0;
          let sumY = 0;
          let sumZ = 0;
          for (const corner of corners) {
            const i = corner * 3;
            mark(positions[i], positions[i + 1], positions[i + 2]);
            sumX += positions[i];
            sumY += positions[i + 1];
            sumZ += positions[i + 2];
          }
          mark(sumX / 4, sumY / 4, sumZ / 4);
        }
      }
      return coveredCount / covered.length;
    }

    // "Falls": release every pin so whatever is left drops away.
    dropAll() {
      this.inverseMass.fill(1);
      this.gravity = this.fullGravity;
    }

    // True once every point is below the bottom of the screen.
    isAllBelowScreen() {
      const limit = -this.viewHalfHeight - 0.05;
      for (let i = 1; i < this.positions.length; i += 3) {
        if (this.positions[i] > limit) return false;
      }
      return true;
    }

    // Triangle index for every intact cell (two triangles per cell).
    buildIndex() {
      const indices = [];
      for (let row = 0; row < this.rows; row++) {
        for (let column = 0; column < this.columns; column++) {
          if (!this.isCellIntact(column, row)) continue;
          const topLeft = this.pointIndex(column, row);
          const topRight = this.pointIndex(column + 1, row);
          const bottomLeft = this.pointIndex(column, row + 1);
          const bottomRight = this.pointIndex(column + 1, row + 1);
          indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
        }
      }
      this.topologyChanged = false;
      return indices;
    }
  }

  customElements.define(
    'tearable-cover',
    class TearableCover extends HTMLElement {
      constructor() {
        super();
        this.inertElements = [];
        this.isOpen = false;
        this.isRevealing = false;
        this.revealTimer = null;
        this.cloth = null;
        this.resizeFrame = null;
        this.frameRequest = null;
        this.rebuildTimer = null;
        this.buildToken = 0; // invalidates in-flight cloth builds (see startCloth)
        this.onRevealClick = this.onRevealClick.bind(this);
        this.onKeyDown = this.onKeyDown.bind(this);
        this.onResize = this.onResize.bind(this);
        this.onVisibilityChange = this.onVisibilityChange.bind(this);
        this.clothDisabled = false; // set when the device proved too slow: stay static
        this.onFrame = this.onFrame.bind(this);
        this.pointer = null; // active drag: { id, x, y, dx, dy } in simulation coordinates
        this.hover = null; // latest pointer position for ripples: { x, y, distance }
        this.onPointerDown = this.onPointerDown.bind(this);
        this.onPointerMove = this.onPointerMove.bind(this);
        this.onPointerUp = this.onPointerUp.bind(this);
        this.onPointerLeave = this.onPointerLeave.bind(this);
      }

      connectedCallback() {
        this.designMode = this.dataset.designMode === 'true';
        this.effects = {
          wind: this.dataset.wind === 'true',
          ripples: this.dataset.ripples === 'true',
          falls: this.dataset.falls === 'true', // see reveal()
        };
        this.showOnce = this.dataset.showMode === 'once';
        this.storageKey = this.dataset.storageKey;

        // Already torn on this browser: hide before the cover is ever painted
        // (the element stays display:none until this definition runs).
        if (!this.designMode && this.showOnce && this.hasBeenShown()) {
          this.hidden = true;
          return;
        }

        this.revealButton = this.querySelector('[data-tearable-cover-reveal]');
        if (this.revealButton) this.revealButton.addEventListener('click', this.onRevealClick);
        document.addEventListener('keydown', this.onKeyDown);

        this.open();
        if (this.canUseCloth()) {
          window.addEventListener('resize', this.onResize);
          document.addEventListener('visibilitychange', this.onVisibilityChange);
          this.startCloth();
        }
      }

      disconnectedCallback() {
        // Also runs when the theme editor re-renders the section.
        if (this.revealButton) this.revealButton.removeEventListener('click', this.onRevealClick);
        document.removeEventListener('keydown', this.onKeyDown);
        clearTimeout(this.revealTimer);
        this.stopViewportListeners();
        this.destroyCloth();
        this.unlockPage();
      }

      open() {
        this.isOpen = true;
        this.lockPage();

        // In the editor, every setting change re-renders the section; focusing here
        // would pull focus out of the settings field the merchant is typing in.
        if (!this.designMode && this.revealButton) {
          this.revealButton.focus({ preventScroll: true });
        }
      }

      onRevealClick() {
        this.reveal();
      }

      onKeyDown(event) {
        if (event.key === 'Escape' && this.isOpen) this.reveal();
      }

      // Clear the cover: Reveal button, Escape, or the auto-clear. With the cloth running and
      // "falls" on, the remaining cloth drops away (onFrame finishes it); otherwise it fades.
      reveal() {
        if (!this.isOpen || this.isRevealing) return;
        this.isRevealing = true;
        this.pointer = null;
        this.classList.add('is-clearing'); // fades the instruction panel

        if (this.cloth && this.effects.falls) {
          this.cloth.simulation.dropAll();
          this.fallStartTime = performance.now();
          return;
        }
        this.fadeOut();
      }

      fadeOut() {
        this.fallStartTime = null;
        this.classList.add('is-revealing');
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.revealTimer = setTimeout(() => this.finishReveal(), reducedMotion ? 0 : 300);
      }

      finishReveal() {
        this.isOpen = false;
        this.isRevealing = false;
        this.hidden = true;
        this.classList.remove('is-revealing', 'is-clearing');
        document.removeEventListener('keydown', this.onKeyDown);

        this.stopViewportListeners();
        this.destroyCloth();
        this.unlockPage();
        this.markShown();
        this.focusPageHeading();
      }

      lockPage() {
        document.documentElement.classList.add('tearable-cover-open');

        // Make everything outside the cover's section unreachable by keyboard,
        // pointer and screen reader until the cover is gone.
        const ownSection = this.closest('.shopify-section') || this;
        Array.from(document.body.children).forEach((element) => {
          if (element === ownSection || element.contains(this) || element.inert) return;
          if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') return;
          element.inert = true;
          this.inertElements.push(element);
        });
      }

      unlockPage() {
        document.documentElement.classList.remove('tearable-cover-open');
        this.inertElements.forEach((element) => {
          element.inert = false;
        });
        this.inertElements = [];
      }

      focusPageHeading() {
        // Gift card page: the balance <h1>. Generic fallback: first <h1>, then <main>.
        const target =
          Array.from(document.querySelectorAll('h1')).find((heading) => !this.contains(heading)) ||
          document.querySelector('main');
        if (!target) return;

        if (!target.hasAttribute('tabindex')) {
          target.setAttribute('tabindex', '-1');
          target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
        }
        target.focus({ preventScroll: true });
      }

      /* ---------- three.js cloth ---------- */

      canUseCloth() {
        if (!this.dataset.threeUrl) return false;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;

        // three.js r163+ requires WebGL2. Probe with a throwaway context, then free it.
        try {
          const probe = document.createElement('canvas').getContext('webgl2');
          if (!probe) return false;
          const loseContext = probe.getExtension('WEBGL_lose_context');
          if (loseContext) loseContext.loseContext();
          return true;
        } catch (error) {
          return false;
        }
      }

      async startCloth() {
        const token = ++this.buildToken;
        // Stale if the visitor revealed, the editor re-rendered, or a newer build started.
        const isStale = () => token !== this.buildToken || !this.isConnected || !this.isOpen || this.isRevealing;

        try {
          const image = this.querySelector('.tearable-cover__image');
          if (!image) return;

          const [THREE] = await Promise.all([import(this.dataset.threeUrl), image.decode()]);
          if (isStale()) return;

          const texture = await this.createTexture(THREE, image);
          if (isStale()) {
            texture.dispose();
            return;
          }

          this.cloth = this.createScene(THREE, texture, image);
          this.layoutCloth();
          this.updateGeometry();
          this.renderCloth();

          // Swap only after the first frame is drawn: the picture → canvas change is invisible.
          this.classList.add('is-cloth-ready');
          this.startLoop();
        } catch (error) {
          // Any failure leaves the static cover in place, which is fully usable.
          if (token === this.buildToken) this.destroyCloth();
        }
      }

      async createTexture(THREE, image) {
        // Freeze the picture the browser chose (desktop or mobile) into a canvas, so a
        // later <picture> source swap (rotation) can't change the texture mid-tear.
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);

        let texture;
        try {
          context.getImageData(0, 0, 1, 1); // Throws if the image is cross-origin without CORS.
          texture = new THREE.CanvasTexture(canvas);
        } catch (error) {
          // Cross-origin image: re-request it with CORS. Rejects (→ static cover) if refused.
          const loader = new THREE.TextureLoader();
          loader.setCrossOrigin('anonymous');
          texture = await loader.loadAsync(image.currentSrc || image.src);
        }

        texture.colorSpace = THREE.SRGBColorSpace;
        // The cloth overhangs the viewport; mirroring past the image edge reads as more cloth.
        texture.wrapS = THREE.MirroredRepeatWrapping;
        texture.wrapT = THREE.MirroredRepeatWrapping;
        texture.anisotropy = 4;
        texture.userData.aspect = canvas.width / canvas.height;
        return texture;
      }

      createScene(THREE, texture, image) {
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setClearColor(0x000000, 0);
        renderer.shadowMap.enabled = CLOTH_SHADOWS;
        renderer.shadowMap.type = THREE.PCFShadowMap; // r186 removed PCFSoftShadowMap
        renderer.domElement.className = 'tearable-cover__canvas';
        renderer.domElement.setAttribute('aria-hidden', 'true');
        this.querySelector('.tearable-cover__picture').after(renderer.domElement);
        renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
        renderer.domElement.addEventListener('pointermove', this.onPointerMove);
        renderer.domElement.addEventListener('pointerup', this.onPointerUp);
        renderer.domElement.addEventListener('pointercancel', this.onPointerUp);
        renderer.domElement.addEventListener('pointerleave', this.onPointerLeave);

        const scene = new THREE.Scene();
        // World units: the viewport is 2 units tall at z = 0.
        const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
        camera.position.z = 1 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));

        // Cloth size: the viewport plus an off-screen overhang on every side (the pinned border).
        const viewportAspect = this.clientWidth / this.clientHeight;
        const viewWidth = 2 * viewportAspect;
        const viewHeight = 2;
        const overhang = 0.06;
        const clothWidth = viewWidth * (1 + 2 * overhang);
        const clothHeight = viewHeight * (1 + 2 * overhang);

        // Grid density: square cells about 1/64 of the screen's long side, so a phone gets
        // a coarser grid (less physics work) and any window shape keeps square cells.
        // Near-square screens would get many cells, so cells also grow to cap the grid
        // at roughly 3000 points.
        const clothArea = this.clientWidth * this.clientHeight * (1 + 2 * overhang) ** 2;
        const cellSize = Math.max(Math.max(this.clientWidth, this.clientHeight) / 64, Math.sqrt(clothArea / 3000)); // CSS px
        const clampCount = (count) => Math.max(8, Math.min(96, Math.round(count)));
        const columns = clampCount((this.clientWidth * (1 + 2 * overhang)) / cellSize);
        const rows = clampCount((this.clientHeight * (1 + 2 * overhang)) / cellSize);
        const simulation = new ClothSimulation({
          width: clothWidth,
          height: clothHeight,
          columns,
          rows,
          cellSizePx: cellSize,
          viewWidth,
          viewHeight,
        });
        simulation.windEnabled = this.effects.wind;

        // Texture coordinates reproduce `object-fit: cover` + `object-position` (the
        // "Keep visible when cropping" anchor, read from the CSS) for the viewport area.
        // The overhang continues past it; MirroredRepeatWrapping covers beyond the image edge.
        const [anchorX, anchorY] = getComputedStyle(image)
          .objectPosition.split(' ')
          .map((value) => (parseFloat(value) || 0) / 100);
        const imageAspect = texture.userData.aspect;
        const visibleX = Math.min(1, viewportAspect / imageAspect);
        const visibleY = Math.min(1, imageAspect / viewportAspect);
        const offsetX = (1 - visibleX) * anchorX;
        const offsetY = (1 - visibleY) * (1 - anchorY); // UV y runs bottom → top, CSS top → bottom

        const rest = simulation.restPositions;
        const uvs = new Float32Array((rest.length / 3) * 2);
        for (let point = 0; point < rest.length / 3; point++) {
          const viewU = (rest[point * 3] + viewWidth / 2) / viewWidth;
          const viewV = (rest[point * 3 + 1] + viewHeight / 2) / viewHeight;
          uvs[point * 2] = offsetX + viewU * visibleX;
          uvs[point * 2 + 1] = offsetY + viewV * visibleY;
        }

        const geometry = new THREE.BufferGeometry();
        // The position attribute shares the simulation's array: physics writes, GPU reads.
        const positionAttribute = new THREE.BufferAttribute(simulation.positions, 3);
        positionAttribute.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('position', positionAttribute);
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

        // Two layers share one geometry. The front draws only triangles facing the camera
        // (the image); the back draws only triangles facing away (the cloth's reverse,
        // seen where a flap folds over). Each triangle is drawn by exactly one layer, so
        // they can't flicker against each other.
        const material = new THREE.MeshLambertMaterial({ map: texture, side: THREE.FrontSide });
        const backMaterial = new THREE.MeshLambertMaterial({
          color: this.clothBackingColor(THREE),
          side: THREE.BackSide,
        });
        const front = new THREE.Mesh(geometry, material);
        const back = new THREE.Mesh(geometry, backMaterial);
        front.castShadow = true;
        front.receiveShadow = true;
        back.receiveShadow = true;
        // The cloth deforms, so its bounding sphere goes stale: never cull it.
        front.frustumCulled = false;
        back.frustumCulled = false;
        const clothGroup = new THREE.Group();
        clothGroup.add(front, back);
        scene.add(clothGroup);

        // Lighting, calibrated so a FLAT cloth shows the image at exactly its original
        // brightness: ambient share + directional share × cos(angle to the light) = 1.
        // Folds turned away from the light darken; folds facing it brighten slightly.
        // (three.js Lambert divides by π, so each share is multiplied by π.)
        const lightDirection = new THREE.Vector3(-1, 1, 2).normalize(); // from top-left, in front
        const ambientShare = 0.55;
        const directionalShare = (1 - ambientShare) / lightDirection.z;
        scene.add(new THREE.AmbientLight(0xffffff, ambientShare * Math.PI));
        const light = new THREE.DirectionalLight(0xffffff, directionalShare * Math.PI);
        light.position.copy(lightDirection).multiplyScalar(4);
        light.castShadow = CLOTH_SHADOWS;
        if (CLOTH_SHADOWS) {
          // Shadow camera covers the whole cloth; biases keep the flat cloth free of
          // speckled self-shadowing ("shadow acne").
          const isSmallScreen = Math.min(this.clientWidth, this.clientHeight) < 750;
          const extent = Math.max(clothWidth, clothHeight) * 0.75;
          light.shadow.mapSize.set(isSmallScreen ? 512 : 1024, isSmallScreen ? 512 : 1024);
          Object.assign(light.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 0.5, far: 10 });
          light.shadow.bias = -0.0005;
          light.shadow.normalBias = 0.02;
        }
        scene.add(light);

        return {
          THREE,
          renderer,
          scene,
          camera,
          clothGroup,
          geometry,
          material,
          backMaterial,
          light,
          texture,
          simulation,
          positionAttribute,
          baseAspect: viewportAspect,
        };
      }

      layoutCloth() {
        const { renderer, camera, clothGroup, baseAspect } = this.cloth;
        const width = this.clientWidth;
        const height = this.clientHeight;
        const viewportAspect = width / height;

        // Phones have very dense screens: 1.5× is still sharp and far cheaper to draw.
        const isSmallScreen = Math.min(width, height) < 750;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isSmallScreen ? 1.5 : 2));
        renderer.setSize(width, height, false);
        camera.aspect = viewportAspect;
        camera.updateProjectionMatrix();

        // The simulation keeps the size it was built with; after a small resize of a torn
        // cloth the mesh is stretched horizontally to fill the viewport (see onResize).
        clothGroup.scale.set(viewportAspect / baseAspect, 1, 1);
      }

      updateGeometry() {
        const { simulation, geometry, positionAttribute } = this.cloth;
        if (simulation.topologyChanged) geometry.setIndex(simulation.buildIndex());
        positionAttribute.needsUpdate = true;
        geometry.computeVertexNormals(); // lighting follows the cloth's current shape
        simulation.moved = false;
      }

      renderCloth() {
        const { renderer, scene, camera } = this.cloth;
        renderer.render(scene, camera);
      }

      startLoop() {
        this.lastFrameTime = performance.now();
        this.lastClearCheck = this.lastFrameTime;
        this.fallStartTime = null;
        this.accumulator = 0;
        this.resetWatchdog(this.lastFrameTime);
        this.frameRequest = requestAnimationFrame(this.onFrame);
      }

      // Slow-device check: average frame time over the cloth's first 2 seconds.
      resetWatchdog(now) {
        this.watchdog = { start: now, frames: 0, total: 0, done: false };
      }

      updateWatchdog(now, frameTime) {
        const watchdog = this.watchdog;
        if (!watchdog || watchdog.done) return;
        if (frameTime < 250) {
          // Longer gaps are the tab being hidden or a one-off stall, not the device.
          watchdog.total += frameTime;
          watchdog.frames++;
        }
        if (now - watchdog.start < 2000) return;
        watchdog.done = true;

        const averageFrameTime = watchdog.frames ? watchdog.total / watchdog.frames : 0;
        // Under 25 fps: hand over to the static cover, which works the same. Only while
        // untouched, so the visitor's tears never jump back.
        if (averageFrameTime > 40 && this.cloth.simulation.tornCount === 0 && !this.isRevealing) {
          this.fallBackToStatic();
        }
      }

      fallBackToStatic() {
        this.clothDisabled = true;
        this.destroyCloth(); // removes is-cloth-ready: the static picture shows again
      }

      onVisibilityChange() {
        if (!this.cloth) return;
        if (document.hidden) {
          // Hidden tab: stop the loop entirely.
          if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
          this.frameRequest = null;
          return;
        }
        // Back: resume without a jump (no catch-up physics), and give the slow-device
        // check a fresh window if it hadn't finished.
        if (this.frameRequest) return;
        this.lastFrameTime = performance.now();
        this.accumulator = 0;
        if (this.watchdog && !this.watchdog.done) this.resetWatchdog(this.lastFrameTime);
        this.frameRequest = requestAnimationFrame(this.onFrame);
      }

      onFrame(now) {
        if (!this.cloth) return;
        this.frameRequest = requestAnimationFrame(this.onFrame);

        // Fixed physics timestep: the cloth behaves the same at 30, 60 or 120 fps.
        // At most 3 steps per frame, so a slow frame can't snowball into slower ones.
        const timeStep = 1 / 60;
        const frameTime = now - this.lastFrameTime;
        this.accumulator += Math.min(frameTime / 1000, 0.1);
        this.lastFrameTime = now;

        this.updateWatchdog(now, frameTime);
        if (!this.cloth) return; // the watchdog fell back to the static cover

        const { simulation } = this.cloth;
        if (this.effects.ripples && this.hover && this.hover.distance > 0) {
          simulation.ripple(this.hover.x, this.hover.y, this.hover.distance);
          this.hover.distance = 0;
        }
        if (this.pointer && (this.pointer.dx || this.pointer.dy)) {
          simulation.drag(this.pointer.x, this.pointer.y, this.pointer.dx, this.pointer.dy);
          this.pointer.dx = 0;
          this.pointer.dy = 0;
        }

        let steps = 0;
        while (this.accumulator >= timeStep && steps < 3) {
          simulation.step(timeStep);
          this.accumulator -= timeStep;
          steps++;
        }
        if (steps === 3) this.accumulator = 0;

        this.checkClear(now);

        // Draw only when something changed: a cloth at rest costs almost nothing.
        if (simulation.moved || simulation.topologyChanged) {
          this.updateGeometry();
          this.renderCloth();
        }
      }

      // Auto-clear and fall progress, checked about 4× a second (the flood-fill is cheap but
      // doesn't need to run every frame).
      checkClear(now) {
        const { simulation } = this.cloth;

        if (this.fallStartTime) {
          // Falling: finish once everything is off screen, or after 2.5 s at most.
          if (simulation.isAllBelowScreen() || now - this.fallStartTime > 2500) this.fadeOut();
          return;
        }

        if (this.isRevealing || simulation.tornCount === 0 || now - this.lastClearCheck < 250) return;
        this.lastClearCheck = now;
        // Also freezes loose pieces that have fallen off screen, so keep running it while
        // anything is torn, even when nothing new tears.
        const cameraDistance = this.cloth.camera.position.z;
        if (simulation.coveredScreenShare(cameraDistance) < 1 - AUTO_CLEAR_SHARE) this.reveal();
      }

      /* ---------- pointer: drag to tear ---------- */

      onPointerDown(event) {
        if (!this.cloth || this.isRevealing || this.pointer) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const { x, y } = this.toSimulation(event);
        this.pointer = { id: event.pointerId, x, y, dx: 0, dy: 0 };
      }

      onPointerMove(event) {
        if (!this.cloth) return;
        const { x, y } = this.toSimulation(event);

        // Ripples follow any pointer movement: mouse hover, or a finger while dragging.
        if (this.hover) {
          this.hover.distance += Math.hypot(x - this.hover.x, y - this.hover.y);
          this.hover.x = x;
          this.hover.y = y;
        } else {
          this.hover = { x, y, distance: 0 }; // first sighting: no jump from a stale position
        }

        if (!this.pointer || event.pointerId !== this.pointer.id) return;
        this.pointer.dx += x - this.pointer.x;
        this.pointer.dy += y - this.pointer.y;
        this.pointer.x = x;
        this.pointer.y = y;
      }

      onPointerUp(event) {
        if (!this.pointer || event.pointerId !== this.pointer.id) return;
        this.pointer = null;
        if (event.pointerType === 'touch') this.hover = null; // a lifted finger isn't hovering
      }

      onPointerLeave() {
        this.hover = null;
      }

      // Screen position → point on the cloth plane (z = 0) in simulation coordinates.
      toSimulation(event) {
        const { renderer, camera, clothGroup } = this.cloth;
        const rect = renderer.domElement.getBoundingClientRect();
        const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = 1 - ((event.clientY - rect.top) / rect.height) * 2;
        // The viewport is 2 units tall at z = 0, so world = NDC × half-size; the mesh may
        // be stretched horizontally after a resize.
        return { x: (ndcX * camera.aspect) / clothGroup.scale.x, y: ndcY };
      }

      // The cloth's reverse side: the theme's background color lifted slightly toward its
      // text color (main color scheme). Pure near-black hides the shading that makes folds
      // readable, so the backing is a touch lighter than the page.
      clothBackingColor(THREE) {
        const styles = getComputedStyle(this);
        const toColor = (name, fallback) => {
          const rgb = styles.getPropertyValue(name).trim();
          return rgb ? new THREE.Color(`rgb(${rgb})`) : new THREE.Color(fallback);
        };
        const background = toColor('--color-background', 0x1f1f21);
        const foreground = toColor('--color-foreground', 0xffffff);
        return background.lerp(foreground, 0.18);
      }

      onResize() {
        if (this.clothDisabled) return; // static cover: CSS handles every size
        const torn = this.cloth && this.cloth.simulation.tornCount > 0;
        const clearing = this.cloth && this.isRevealing; // falling or fading: just re-fit

        if (torn || clearing) {
          // Rebuilding would undo the visitor's tears. Small changes (address bar, a nudged
          // window): stretch the cloth to fit. Big shape changes (rotating a phone) would
          // distort it badly, so the remaining cloth clears, as if Reveal was pressed.
          const shapeChange = this.clientWidth / this.clientHeight / this.cloth.baseAspect;
          if (!clearing && (shapeChange > 1.25 || shapeChange < 0.8)) {
            this.reveal(); // then re-fit below, so the clear plays at the new size
          }
          if (this.resizeFrame) return;
          this.resizeFrame = requestAnimationFrame(() => {
            this.resizeFrame = null;
            if (!this.cloth) return;
            this.layoutCloth();
            this.renderCloth();
          });
          return;
        }

        // Untouched cloth: show the CSS picture while resizing (always cropped correctly,
        // and it switches to the mobile image on portrait screens), then rebuild the cloth
        // for the new size once resizing settles.
        this.classList.remove('is-cloth-ready');
        clearTimeout(this.rebuildTimer);
        this.rebuildTimer = setTimeout(() => {
          this.rebuildTimer = null;
          if (!this.isOpen || this.isRevealing) return;
          this.destroyCloth();
          this.startCloth();
        }, 250);
      }

      stopViewportListeners() {
        window.removeEventListener('resize', this.onResize);
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        clearTimeout(this.rebuildTimer);
        this.rebuildTimer = null;
      }

      destroyCloth() {
        this.buildToken++; // any build still loading is now stale
        if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
        if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
        this.resizeFrame = null;
        this.frameRequest = null;
        this.pointer = null;
        this.hover = null;
        this.classList.remove('is-cloth-ready');

        if (!this.cloth) return;
        const { renderer, geometry, material, backMaterial, light, texture } = this.cloth;
        renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
        renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
        renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
        renderer.domElement.removeEventListener('pointercancel', this.onPointerUp);
        renderer.domElement.removeEventListener('pointerleave', this.onPointerLeave);
        geometry.dispose();
        material.dispose();
        backMaterial.dispose();
        light.dispose(); // frees the shadow map
        texture.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        this.cloth = null;
      }

      /* ---------- storage ---------- */

      hasBeenShown() {
        try {
          return window.localStorage.getItem(this.storageKey) === 'shown';
        } catch (error) {
          // Storage blocked (private mode, strict settings): treat as not shown yet.
          return false;
        }
      }

      markShown() {
        if (this.designMode || !this.showOnce || !this.storageKey) return;
        try {
          window.localStorage.setItem(this.storageKey, 'shown');
        } catch (error) {
          // Storage blocked: the cover simply shows again next visit.
        }
      }
    }
  );
}
