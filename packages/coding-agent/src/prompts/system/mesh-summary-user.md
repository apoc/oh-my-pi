<session>
{{#if sessionName}}Name: {{sessionName}}
{{/if}}Project: {{cwd}}
</session>
{{#if phases.length}}
<plan>
{{#each phases}}
{{name}}:
{{#each tasks}}
- [{{status}}] {{content}}
{{/each}}
{{/each}}
</plan>
{{/if}}
<requests>
{{#each requests}}
<user>
{{this}}
</user>
{{/each}}
</requests>
{{#if assistant}}
<latest-reply>
{{assistant}}
</latest-reply>
{{/if}}
