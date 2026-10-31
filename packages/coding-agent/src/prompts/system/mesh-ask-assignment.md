Mesh peer `{{from}}` (host `{{host}}`) asks about this session.
{{#if history.length}}

Earlier exchanges in this thread, oldest first:
{{#each history}}
<question>
{{question}}
</question>
<answer>
{{answer}}
</answer>
{{/each}}
{{/if}}

Answer this question:
<question>
{{question}}
</question>
