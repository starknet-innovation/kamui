<script lang="ts">
  import { kamui } from './kamui.svelte';
</script>

{#if kamui.status === 'loading'}
  <p>Checking your session…</p>
{:else if kamui.connection}
  <p>Account: <code>{kamui.connection.account}</code></p>
  <p>Session ends {new Date(kamui.connection.session.validUntil * 1000).toLocaleString()}</p>
  <button onclick={() => kamui.disconnect()}>Disconnect</button>
{:else}
  <button onclick={() => kamui.connect()}>Connect with Kamui</button>
  {#if kamui.error}<p role="alert">{kamui.error}</p>{/if}
{/if}
