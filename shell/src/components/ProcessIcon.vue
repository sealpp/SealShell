<script lang="ts">
import type { Component } from 'vue'
import { IconAppWindow, IconBrandDeno, IconBrandDocker, IconBrandMysql, IconBrandNodejs, IconBrandPhp, IconBrandPython, IconCoffee, IconSettings, IconTerminal2 } from '@tabler/icons-vue'
import { nginxPath, postgresqlPath, redisPath } from '../assets/process-icons/brand-paths'
import { processIconKind, type ProcessIconKind } from '../services/processes/icon'

interface IconDefinition { label: string; component?: Component; path?: string }
const icons: Record<ProcessIconKind, IconDefinition> = {
  process: { label: '进程', component: IconAppWindow },
  shell: { label: 'Shell / SSH', component: IconTerminal2 },
  node: { label: 'Node.js', component: IconBrandNodejs },
  python: { label: 'Python', component: IconBrandPython },
  java: { label: 'Java', component: IconCoffee },
  php: { label: 'PHP', component: IconBrandPhp },
  deno: { label: 'Deno', component: IconBrandDeno },
  docker: { label: 'Docker', component: IconBrandDocker },
  mysql: { label: 'MySQL', component: IconBrandMysql },
  nginx: { label: 'NGINX', path: nginxPath },
  redis: { label: 'Redis', path: redisPath },
  postgresql: { label: 'PostgreSQL', path: postgresqlPath },
  system: { label: '系统初始化', component: IconSettings },
}
</script>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ name: string }>()
const kind = computed(() => processIconKind(props.name))
const icon = computed(() => icons[kind.value])
</script>

<template>
  <span class="process-icon" :data-process-icon="kind" :title="icon.label" aria-hidden="true">
    <svg v-if="icon.path" viewBox="0 0 24 24" fill="currentColor" focusable="false"><path :d="icon.path" /></svg>
    <component :is="icon.component" v-else :size="16" :stroke-width="1.75" />
  </span>
</template>

<style scoped>
.process-icon { display: inline-flex; width: 16px; height: 16px; flex: 0 0 16px; color: inherit; vertical-align: middle; }
.process-icon svg { display: block; width: 16px; height: 16px; }
</style>
