if (!customElements.get('modern-product-grid')) {
  customElements.define(
    'modern-product-grid',
    class ModernProductGrid extends HTMLElement {
      connectedCallback() {
        this.supportsHover = window.matchMedia('(hover: hover)').matches;
        if (!this.supportsHover) return;

        this.cards = this.querySelectorAll('.modern-card[data-has-secondary="true"]');
        this.handleMouseEnter = this.handleMouseEnter.bind(this);
        this.handleMouseLeave = this.handleMouseLeave.bind(this);

        this.cards.forEach((card) => {
          card.addEventListener('mouseenter', this.handleMouseEnter);
          card.addEventListener('mouseleave', this.handleMouseLeave);
        });
      }

      disconnectedCallback() {
        if (!this.cards) return;

        this.cards.forEach((card) => {
          card.removeEventListener('mouseenter', this.handleMouseEnter);
          card.removeEventListener('mouseleave', this.handleMouseLeave);
        });
      }

      handleMouseEnter(event) {
        event.currentTarget.classList.add('is-hovering');
      }

      handleMouseLeave(event) {
        event.currentTarget.classList.remove('is-hovering');
      }
    }
  );
}
