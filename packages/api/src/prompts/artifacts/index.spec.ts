import { ArtifactModes } from 'librechat-data-provider';
import { generateArtifactsPrompt } from './index';

describe('generateArtifactsPrompt runtime compatibility', () => {
  it('requires React requests to use the React artifact runtime', () => {
    const prompt = generateArtifactsPrompt({
      endpoint: 'SG AI Gateway',
      artifacts: ArtifactModes.DEFAULT,
    });

    expect(prompt).toContain('use artifact type "application/vnd.react"');
    expect(prompt).toContain('import { useState } from "react"');
    expect(prompt).toContain('never load react.development.js');
  });

  it('requires HTML artifacts to be framework-free and self-contained', () => {
    const prompt = generateArtifactsPrompt({
      endpoint: 'SG AI Gateway',
      artifacts: ArtifactModes.DEFAULT,
    });

    expect(prompt).toContain('framework-free, self-contained HTML/CSS/JavaScript');
    expect(prompt).toContain('HTML artifacts cannot load remote scripts');
  });

  it('keeps custom artifact mode free of built-in instructions', () => {
    expect(
      generateArtifactsPrompt({ endpoint: 'SG AI Gateway', artifacts: ArtifactModes.CUSTOM }),
    ).toBeNull();
  });
});
