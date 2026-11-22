Mesh peer `{{from}}` (host `{{host}}`) asks about this session.
{{#if history.length}}

Earlier exchanges in this thread, oldest first:
{{#each history}}
<mesh-question>
{{question}}
</mesh-question>
<mesh-answer>
{{answer}}
</mesh-answer>
{{/each}}
{{/if}}

Answer this question:
<mesh-question>
{{question}}
</mesh-question>
