<script lang="ts">
import type { Component } from 'vue'
import { IconAppWindow, IconBrandDeno, IconBrandDocker, IconBrandMysql, IconBrandNodejs, IconBrandPhp, IconBrandPython, IconBrandOpenai, IconBrandNpm, IconBrandPnpm, IconBrandYarn, IconBrandVite, IconBrandTypescript, IconBrandNextjs, IconRobot, IconCoffee, IconSettings, IconTerminal2 } from '@tabler/icons-vue'
import { clickhousePath, nginxPath, postgresqlPath, redisPath } from '../assets/process-icons/brand-paths'
import { pyreflyPaths, pyreflyViewBox } from '../assets/process-icons/pyrefly'
import { processIconKind, type ProcessIconKind } from '../services/processes/icon'
import type { ProcessRow } from '../services/processes/types'

interface IconDefinition { label: string; component?: Component; paths?: string[]; viewBox?: string }
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
  nginx: { label: 'NGINX', paths: [nginxPath] },
  redis: { label: 'Redis', paths: [redisPath] },
  postgresql: { label: 'PostgreSQL', paths: [postgresqlPath] },
  system: { label: '系统初始化', component: IconSettings },
  clickhouse: { label: 'ClickHouse', paths: [clickhousePath] },
  codex: { label: 'Codex / OpenAI', component: IconBrandOpenai },
  pyrefly: { label: 'Pyrefly', paths: pyreflyPaths, viewBox: pyreflyViewBox },
  devin: { label: 'Devin（代理工具）', component: IconRobot },
  npm: { label: 'npm / npx', component: IconBrandNpm },
  pnpm: { label: 'pnpm', component: IconBrandPnpm },
  yarn: { label: 'Yarn', component: IconBrandYarn },
  vite: { label: 'Vite', component: IconBrandVite },
  typescript: { label: 'TypeScript', component: IconBrandTypescript },
  nextjs: { label: 'Next.js', component: IconBrandNextjs },
}
</script>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ process: Pick<ProcessRow, 'name' | 'argv'> }>()
const kind = computed(() => processIconKind(props.process))
const icon = computed(() => icons[kind.value])
</script>

<template>
  <span class="process-icon" :data-process-icon="kind" :title="icon.label" aria-hidden="true">
    <svg v-if="icon.paths" :viewBox="icon.viewBox ?? '0 0 24 24'" fill="currentColor" focusable="false"><path v-for="(path, index) in icon.paths" :key="index" :d="path" /></svg>
    <component :is="icon.component" v-else :size="16" :stroke-width="1.75" />
  </span>
</template>

<style scoped>
.process-icon { display: inline-flex; width: 16px; height: 16px; flex: 0 0 16px; color: inherit; vertical-align: middle; }
.process-icon svg { display: block; width: 16px; height: 16px; }
</style>
