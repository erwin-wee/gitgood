import React, { useState } from 'react';
import type { FileDiff } from '@shared/types';
import { formatBytes } from '@shared/util';
import { Segmented } from '../ui';

type ImageData = Extract<FileDiff, { kind: 'image' }>;
type Mode = 'two-up' | 'swipe' | 'onion' | 'difference';

function src(img: { mediaType: string; base64: string }): string {
  return `data:${img.mediaType};base64,${img.base64}`;
}

function Dimensions({ url }: { url: string }): React.JSX.Element | null {
  const [dims, setDims] = useState<string | null>(null);
  return (
    <>
      <img src={url} alt="" style={{ display: 'none' }} onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} />
      {dims ? <span className="muted">{dims}</span> : null}
    </>
  );
}

export function ImageDiff({ diff }: { diff: ImageData }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('two-up');
  const [value, setValue] = useState(50);
  const both = diff.oldImage && diff.newImage;
  return (
    <div className="image-diff">
      {both ? (
        <div className="modes">
          <Segmented<Mode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'two-up', label: '2-up' },
              { value: 'swipe', label: 'Swipe' },
              { value: 'onion', label: 'Onion skin' },
              { value: 'difference', label: 'Difference' },
            ]}
          />
        </div>
      ) : null}
      {mode === 'two-up' || !both ? (
        <div className="two-up">
          {diff.oldImage ? (
            <div className="image-box">
              <span className="label deleted">{diff.newImage ? 'Previous' : 'Deleted'}</span>
              <img src={src(diff.oldImage)} alt="Previous version" />
              <span className="muted">
                {formatBytes(diff.oldImage.bytes)} <Dimensions url={src(diff.oldImage)} />
              </span>
            </div>
          ) : null}
          {diff.newImage ? (
            <div className="image-box">
              <span className="label added">{diff.oldImage ? 'Current' : 'Added'}</span>
              <img src={src(diff.newImage)} alt="Current version" />
              <span className="muted">
                {formatBytes(diff.newImage.bytes)} <Dimensions url={src(diff.newImage)} />
              </span>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="overlay">
            <img src={src(diff.oldImage!)} alt="Previous" />
            <img
              className="top"
              src={src(diff.newImage!)}
              alt="Current"
              style={
                mode === 'swipe'
                  ? { clipPath: `inset(0 0 0 ${value}%)` }
                  : mode === 'onion'
                    ? { opacity: value / 100 }
                    : { mixBlendMode: 'difference' }
              }
            />
          </div>
          {mode !== 'difference' ? <input type="range" min={0} max={100} value={value} onChange={(e) => setValue(Number(e.target.value))} /> : <span className="muted">Identical regions appear black.</span>}
        </>
      )}
    </div>
  );
}
