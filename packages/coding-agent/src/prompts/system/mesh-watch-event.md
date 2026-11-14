<mesh-watch>
Watched mesh peer `{{from}}` (instance `{{instanceId}}`, host `{{host}}`) reached `{{event}}` (watch `{{watchId}}`).
{{#if originalAgent}}Delivered to you because watching agent `{{originalAgent}}` is no longer running.{{/if}}
{{#if detail}}

{{detail}}
{{/if}}
</mesh-watch>
