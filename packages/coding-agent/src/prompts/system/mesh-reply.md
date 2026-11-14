<mesh-reply>
{{#if error}}Mesh peer `{{from}}` (instance `{{instanceId}}`, host `{{host}}`) failed to answer message `{{replyTo}}`: {{error}}{{else}}Reply from mesh peer `{{from}}` (instance `{{instanceId}}`, host `{{host}}`) to message `{{replyTo}}`:{{/if}}
{{#if originalAgent}}Delivered to you because asking agent `{{originalAgent}}` is no longer running.{{/if}}

{{message}}

{{#if thread}}Follow up in thread `{{thread}}` via `{{toolRefs.mesh_send}}` with `"thread": "{{thread}}"`.{{/if}}
</mesh-reply>
