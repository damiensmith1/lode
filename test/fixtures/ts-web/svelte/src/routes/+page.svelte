<script lang="ts">
  import Card from "$lib/Card.svelte";
  import { format } from "$lib/format";

  function save() {
    return format("x");
  }
</script>

<Card title="hello" />
<button on:click={save}>save</button>
<a href="/blog/first">read</a>
