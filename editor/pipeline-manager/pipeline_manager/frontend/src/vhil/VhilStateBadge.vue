<!--
vHIL: a run's state as text with a glyph, never colour alone
(docs/architecture/editor-workspace.md, "Tokens": status).
-->

<template>
    <span class="vhil-badge" :class="`--${shown}`" :title="warnings.join('; ') || undefined">
        <span aria-hidden="true">{{ glyph }}</span> {{ shown }}
    </span>
</template>

<script>
import { computed, defineComponent } from 'vue';

const GLYPHS = {
    queued: '○', completed: '!', building: '◌', running: '●', passed: '✓', failed: '✕', error: '▲', cancelled: '⊘',
};

export default defineComponent({
    props: {
        state: { type: String, required: true },
        // The run's summary.warnings (#390): a passed run that showed nothing
        // (no app started, no frame) reads "completed", amber, reason on hover.
        warnings: { type: Array, default: () => [] },
    },
    setup(props) {
        const shown = computed(() => (props.state === 'passed' && props.warnings.length
            ? 'completed' : props.state));
        return { shown, glyph: computed(() => GLYPHS[shown.value] ?? '?') };
    },
});
</script>
