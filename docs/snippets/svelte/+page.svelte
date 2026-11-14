<script lang="ts">
  import { onMount } from 'svelte';
  import { kamui } from '$lib/kamui.svelte';
  import UserInfo from '$lib/UserInfo.svelte';
  import Play from '$lib/Play.svelte';

  onMount(() => kamui.init());
</script>

<h1>My game</h1>
<UserInfo />
<Play />
