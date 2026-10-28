if (!customElements.get('scroll-driven-video')) {
  customElements.define(
    'scroll-driven-video',
    class ScrollDrivenVideo extends HTMLElement {
      constructor() {
        super();
        this.isLoaded = false;
        this.isMobile = false;

        // Animation bounds (video time, derived from tooltip start/end times)
        this.animationStartTime = 0;
        this.animationEndTime = 5;

        // Scroll-sync state
        this.lastProgress = -1;
        this.ticking = false;
        this.tooltipsSuppressed = false;
        this.activeTooltips = new Set();

        // Smoothing: ease the displayed video time toward the scroll target so that
        // discrete scroll jumps (keyboard arrows / Page keys / Space) glide through the
        // in-between frames instead of snapping. Wheel/trackpad deltas are tiny, so they
        // stay effectively 1:1. The ease always settles exactly at the target — it only
        // moves toward the scroll position, never past it, so there is no drift.
        this.targetTime = 0;
        this.displayTime = 0;
        this.hasInitialFrame = false;
        this.easeRafId = null;

        // Respect the OS "reduce motion" setting — see connectedCallback.
        this.prefersReducedMotion = false;

        // Bound listeners
        this.scrollListener = this.onScroll.bind(this);
        this.resizeListener = this.onResize.bind(this);
        this.keydownListener = this.handleKeydown.bind(this);
        this.reducedMotionListener = (e) => { this.prefersReducedMotion = e.matches; };
      }

      // Static mode = no scroll-driven motion. Covers mobile (image-stack fallback)
      // and users who request reduced motion (WCAG 2.3.3) — both show the static stack.
      isStaticMode() {
        return this.isMobile || this.prefersReducedMotion;
      }

      connectedCallback() {
        if (!this.hasAttribute('tabindex')) {
          this.setAttribute('tabindex', '0');
        }

        this.sectionId = this.dataset.sectionId;
        this.videoUrl = this.dataset.videoUrl;
        this.hasMobileImages = this.dataset.hasMobileImages === 'true';
        this.tooltipsData = this.buildTooltipsFromDOM();

        this.stage = this.querySelector('.scroll-driven-video__stage');
        this.pin = this.querySelector('.scroll-driven-video__pin');
        this.video = this.querySelector('.scroll-driven-video__video');
        this.videoContainer = this.querySelector('.scroll-driven-video__video-container');
        this.imageStack = this.querySelector('.scroll-driven-video__image-stack');
        this.tooltipContainer = this.querySelector('.scroll-driven-video__tooltips');

        if (!this.video || !this.stage) {
          console.error('scroll-driven-video: Missing required elements');
          return;
        }

        this.setAttribute('role', 'region');
        this.setAttribute('aria-label', 'Scroll-driven product showcase');
        this.video.setAttribute('aria-label', 'Product video that animates as you scroll');
        if (this.tooltipContainer) {
          this.tooltipContainer.setAttribute('aria-label', 'Product feature callouts');
        }

        this.reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        this.prefersReducedMotion = this.reducedMotionQuery.matches;
        this.reducedMotionQuery.addEventListener('change', this.reducedMotionListener);

        this.checkMobileViewport();
        this.setupLazyLoad();
        this.renderTooltips();

        window.addEventListener('scroll', this.scrollListener, { passive: true });
        window.addEventListener('resize', this.resizeListener, { passive: true });
        window.addEventListener('keydown', this.keydownListener);
      }

      buildTooltipsFromDOM() {
        const tooltips = [];
        this.querySelectorAll('.scroll-driven-video__tooltip-data').forEach((el) => {
          const textX = parseFloat(el.dataset.textX);
          const textY = parseFloat(el.dataset.textY);
          tooltips.push({
            text: el.dataset.tooltipText || '',
            subtext: el.dataset.tooltipSubtext || '',
            id: el.dataset.tooltipId,
            textX: isNaN(textX) ? 15 : textX,
            textY: isNaN(textY) ? 50 : textY,
            pointerX: parseInt(el.dataset.pointerX, 10) || 50,
            pointerY: parseInt(el.dataset.pointerY, 10) || 50,
            startTime: parseFloat(el.dataset.startTime) || 0,
            endTime: parseFloat(el.dataset.endTime) || 5
          });
        });
        return tooltips;
      }

      checkMobileViewport() {
        this.isMobile = window.innerWidth < 750;
      }

      setupLazyLoad() {
        if (this.isLoaded || !this.videoUrl) return;
        // Reduced-motion users get the static image stack instead of the scrub, so skip
        // loading the video — UNLESS no mobile images were set, in which case we still
        // load it to show a static poster frame as the fallback.
        if (this.prefersReducedMotion && this.hasMobileImages) return;

        this.observer = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && !this.isLoaded) {
              this.loadVideo();
            }
          });
        }, { rootMargin: '200px 0px' });

        this.observer.observe(this.stage);
      }

      loadVideo() {
        if (this.isLoaded || !this.videoUrl) return;
        this.isLoaded = true;
        this.video.src = this.videoUrl;

        this.video.addEventListener('loadedmetadata', () => {
          this.computeAnimationBounds();
          if (this.isStaticMode()) {
            // Reduced-motion fallback with no images: paint a representative still frame.
            this.applyVideoTime(0);
          } else {
            // Draw the first frame and sync to current scroll position immediately.
            this.update();
          }
        }, { once: true });

        if (this.observer) {
          this.observer.disconnect();
          this.observer = null;
        }
      }

      // Scroll maps onto the FULL video timeline (0 -> duration) so that tooltip
      // start/end times act as absolute seconds. Mapping onto the tooltip range
      // instead would skip the video's opening and break tooltip on/off timing.
      computeAnimationBounds() {
        this.animationStartTime = 0;
        this.animationEndTime = (isFinite(this.video.duration) && this.video.duration > 0)
          ? this.video.duration
          : 5;
      }

      onScroll() {
        // rAF-throttle: one update per frame, no matter how many scroll events fire.
        if (this.ticking) return;
        this.ticking = true;
        requestAnimationFrame(() => {
          this.update();
          this.ticking = false;
        });
      }

      onResize() {
        this.checkMobileViewport();
        this.update();
      }

      // Reads how far the sticky pin has travelled through the tall stage and maps
      // that 0–1 progress directly onto video time. No scroll correction, so progress
      // can only move when the user actually scrolls — it never rewinds on its own.
      update() {
        if (this.isStaticMode() || !this.isLoaded) return;

        const stageRect = this.stage.getBoundingClientRect();
        const scrollable = stageRect.height - window.innerHeight;
        let progress = 0;
        if (scrollable > 0) {
          progress = -stageRect.top / scrollable;
        }
        progress = Math.max(0, Math.min(1, progress));

        const duration = this.animationEndTime - this.animationStartTime;
        this.targetTime = this.animationStartTime + progress * duration;

        // Any real scroll movement re-enables tooltips that Escape hid.
        if (progress !== this.lastProgress) {
          this.tooltipsSuppressed = false;
        }
        this.lastProgress = progress;

        // Drive tooltips from the scroll target (not the eased display time, which can
        // trail slightly) so callouts stay locked exactly to scroll position.
        this.updateTooltipVisibility(this.targetTime);

        // First sync after load: snap to the scroll position so we don't ease from 0.
        if (!this.hasInitialFrame) {
          this.displayTime = this.targetTime;
          this.hasInitialFrame = true;
          this.applyVideoTime(this.displayTime);
          return;
        }

        this.startEaseLoop();
      }

      // Eases the video's displayed time toward the scroll target over a few frames,
      // then stops. Running only while easing keeps it idle (no rAF) when at rest.
      startEaseLoop() {
        if (this.easeRafId !== null) return;
        const tick = () => {
          const diff = this.targetTime - this.displayTime;
          // Settle: snap and stop once we're well under a frame away.
          if (Math.abs(diff) < 0.008) {
            this.displayTime = this.targetTime;
            this.applyVideoTime(this.displayTime);
            this.easeRafId = null;
            return;
          }
          // 0.6 settles in ~3 frames: snappy enough that keyboard stepping feels
          // immediate, while still gliding through frames on larger jumps.
          this.displayTime += diff * 0.6;
          this.applyVideoTime(this.displayTime);
          this.easeRafId = requestAnimationFrame(tick);
        };
        this.easeRafId = requestAnimationFrame(tick);
      }

      applyVideoTime(t) {
        if (this.video.readyState >= 1 && isFinite(t)) {
          // Avoid redundant seeks (and the work they trigger) when nothing changed.
          if (Math.abs(this.video.currentTime - t) > 0.001) {
            this.video.currentTime = t;
          }
        }
      }

      handleKeydown(event) {
        if (event.key === 'Escape') {
          this.hideAllTooltips();
          this.tooltipsSuppressed = true;
        }
        // Arrow keys / Page Up / Page Down intentionally fall through to the browser:
        // native scrolling moves the stage, which drives the animation with zero lag.
      }

      updateTooltipVisibility(currentTime) {
        this.tooltipsData.forEach((tooltip) => {
          const tooltipEl = this.querySelector(`#${tooltip.id}`);
          if (!tooltipEl) return;

          const inRange = currentTime >= tooltip.startTime && currentTime <= tooltip.endTime;
          const shouldShow = inRange && !this.tooltipsSuppressed;

          if (shouldShow && !this.activeTooltips.has(tooltip.id)) {
            this.activeTooltips.add(tooltip.id);
            tooltipEl.classList.add('is-active');
            this.setPointerOpacity(tooltip.id, '1');
          } else if (!shouldShow && this.activeTooltips.has(tooltip.id)) {
            this.activeTooltips.delete(tooltip.id);
            tooltipEl.classList.remove('is-active');
            this.setPointerOpacity(tooltip.id, '0');
          }
        });
      }

      setPointerOpacity(tooltipId, value) {
        const path = this.tooltipContainer
          ? this.tooltipContainer.querySelector(`path.${tooltipId}`)
          : null;
        if (path) path.setAttribute('opacity', value);
      }

      hideAllTooltips() {
        this.activeTooltips.forEach((tooltipId) => {
          const tooltipEl = this.querySelector(`#${tooltipId}`);
          if (tooltipEl) tooltipEl.classList.remove('is-active');
          this.setPointerOpacity(tooltipId, '0');
        });
        this.activeTooltips.clear();
      }

      renderTooltips() {
        if (!this.tooltipContainer) return;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'scroll-driven-video__pointers');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');

        this.tooltipContainer.innerHTML = '';
        this.tooltipContainer.appendChild(svg);

        this.tooltipsData.forEach((tooltip) => {
          const tooltipEl = document.createElement('div');
          tooltipEl.id = tooltip.id;
          tooltipEl.className = 'scroll-driven-video__tooltip';
          tooltipEl.setAttribute('role', 'tooltip');
          tooltipEl.setAttribute('aria-live', 'polite');
          tooltipEl.setAttribute('aria-atomic', 'true');
          tooltipEl.setAttribute('tabindex', '0');

          const label = document.createElement('div');
          label.className = 'scroll-driven-video__tooltip-label';
          // Label is plain text — render as text (and strip any legacy markup such as
          // a previously-saved <h5>) so it can never inject a heading into the page.
          label.textContent = (tooltip.text || '').replace(/<[^>]*>/g, '');

          const description = document.createElement('div');
          description.className = 'scroll-driven-video__tooltip-description';
          description.innerHTML = tooltip.subtext;

          tooltipEl.appendChild(label);
          tooltipEl.appendChild(description);

          this.applyTooltipPosition(tooltipEl, tooltip);
          this.tooltipContainer.appendChild(tooltipEl);

          this.drawTooltipPointer(svg, tooltip, tooltipEl);
        });
      }

      drawTooltipPointer(svg, tooltip, tooltipEl) {
        const targetXPercent = tooltip.pointerX;
        const targetYPercent = tooltip.pointerY;

        const containerRect = this.videoContainer.getBoundingClientRect();
        const tooltipRect = tooltipEl.getBoundingClientRect();
        const tooltipCenterX = containerRect.width
          ? ((tooltipRect.left - containerRect.left) + tooltipRect.width / 2) / containerRect.width * 100
          : 50;

        const pointerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const arcRadius = 1.5;

        const crescentLeft = targetXPercent - arcRadius;
        const crescentRight = targetXPercent + arcRadius;
        const isRightTooltip = tooltipCenterX > targetXPercent;

        // Line runs from the target crescent toward the tooltip, stopping at the
        // half-distance point (0.5) so the gap sits midway between shape and text.
        const endPointX = targetXPercent + (tooltipCenterX - targetXPercent) * 0.5;
        const endPointY = targetYPercent;
        const controlPointX = (targetXPercent + tooltipCenterX) / 2;
        const controlPointY = targetYPercent;

        let pathData;
        if (isRightTooltip) {
          pathData = `M ${endPointX} ${endPointY} Q ${controlPointX} ${controlPointY} ${crescentRight} ${targetYPercent} A ${arcRadius} ${arcRadius} 0 0 0 ${crescentLeft} ${targetYPercent}`;
        } else {
          pathData = `M ${endPointX} ${endPointY} Q ${controlPointX} ${controlPointY} ${crescentLeft} ${targetYPercent} A ${arcRadius} ${arcRadius} 0 0 1 ${crescentRight} ${targetYPercent}`;
        }

        pointerPath.setAttribute('d', pathData);
        pointerPath.setAttribute('stroke', '#ffffff');
        pointerPath.setAttribute('stroke-width', '0.5');
        pointerPath.setAttribute('fill', 'none');
        pointerPath.setAttribute('stroke-linecap', 'round');
        pointerPath.setAttribute('stroke-linejoin', 'round');
        pointerPath.setAttribute('opacity', '0');
        pointerPath.setAttribute('style', 'transition: opacity 0.3s ease-in-out;');
        pointerPath.setAttribute('class', `scroll-driven-video__pointer-line scroll-driven-video__pointer-target ${tooltip.id}`);
        pointerPath.setAttribute('pointer-events', 'none');
        svg.appendChild(pointerPath);
      }

      applyTooltipPosition(el, tooltip) {
        // Text block is centered on its (textX, textY) point within the video frame.
        // Percentages map to the container, so placement is precise and never clips off-screen.
        el.style.position = 'absolute';
        el.style.left = tooltip.textX + '%';
        el.style.top = tooltip.textY + '%';
        el.style.right = 'auto';
        el.style.transform = 'translate(-50%, -50%)';
      }

      disconnectedCallback() {
        window.removeEventListener('scroll', this.scrollListener);
        window.removeEventListener('resize', this.resizeListener);
        window.removeEventListener('keydown', this.keydownListener);
        if (this.easeRafId !== null) {
          cancelAnimationFrame(this.easeRafId);
          this.easeRafId = null;
        }
        if (this.reducedMotionQuery) {
          this.reducedMotionQuery.removeEventListener('change', this.reducedMotionListener);
        }
        if (this.observer) {
          this.observer.disconnect();
        }
      }
    }
  );
}
