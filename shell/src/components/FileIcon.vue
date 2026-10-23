<script lang="ts">
import type { Component } from 'vue'
import {
  IconFile, IconFolder, IconFileSymlink, IconFileUnknown, IconFileText, IconMarkdown, IconFileSettings,
  IconJson, IconBraces, IconCode, IconFileCode, IconBrandJavascript, IconBrandTypescript, IconBrandPython, IconBrandVue,
  IconBrandHtml5, IconBrandCss3, IconTerminal2, IconBrandPowershell, IconTools, IconBrandDocker, IconBrandGit,
  IconPackage, IconLock, IconPhoto, IconMusic, IconMovie, IconFileZip, IconFileTypePdf, IconFileSpreadsheet,
  IconPresentation, IconDatabase, IconFileTypography, IconKey, IconAppWindow, IconBinary, IconDisc,
} from '@tabler/icons-vue'
import { fileTypeLabels, type FileType } from '../services/files/file-type'

const icons: Record<FileType, Component> = {
  directory: IconFolder, symlink: IconFileSymlink, unknown: IconFileUnknown, file: IconFile,
  text: IconFileText, markdown: IconMarkdown, log: IconFileText, config: IconFileSettings,
  json: IconJson, yaml: IconFileSettings, xml: IconFileCode,
  javascript: IconBrandJavascript, typescript: IconBrandTypescript, 'typescript-declaration': IconBrandTypescript,
  python: IconBrandPython, vue: IconBrandVue, html: IconBrandHtml5, css: IconBrandCss3, code: IconCode,
  shell: IconTerminal2, powershell: IconBrandPowershell, batch: IconTerminal2, build: IconTools,
  docker: IconBrandDocker, git: IconBrandGit, dependency: IconPackage, lock: IconLock,
  image: IconPhoto, audio: IconMusic, video: IconMovie, archive: IconFileZip,
  pdf: IconFileTypePdf, document: IconFileText, spreadsheet: IconFileSpreadsheet, presentation: IconPresentation,
  sql: IconBraces, database: IconDatabase, font: IconFileTypography, certificate: IconKey,
  package: IconPackage, application: IconAppWindow, binary: IconBinary, disk: IconDisc,
}
</script>

<script setup lang="ts">
defineProps<{ type: FileType }>()
</script>

<template>
  <span class="file-icon" :data-file-icon="type" :title="fileTypeLabels[type]" aria-hidden="true">
    <component :is="icons[type]" :size="16" :stroke-width="1.75" />
  </span>
</template>

<style scoped>
.file-icon { display: inline-flex; width: 16px; height: 16px; flex: 0 0 16px; color: inherit; }
.file-icon svg { display: block; width: 16px; height: 16px; }
</style>
