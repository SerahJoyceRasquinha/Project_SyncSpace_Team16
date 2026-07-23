/**
 * Stand-in for react-konva. Each export is a component that renders null but
 * still lets React fully execute the parent's render body, which is where the
 * bug we are guarding against lived.
 */
import { forwardRef } from 'react';

const node = (name) => {
  const C = forwardRef(function KonvaStub() { return null; });
  C.displayName = name;
  return C;
};

export const Stage = forwardRef(function Stage(props) { return props.children ?? null; });
export const Layer = forwardRef(function Layer(props) { return props.children ?? null; });
export const Group = forwardRef(function Group(props) { return props.children ?? null; });

export const Line = node('Line');
export const Rect = node('Rect');
export const Circle = node('Circle');
export const Ellipse = node('Ellipse');
export const Star = node('Star');
export const Path = node('Path');
export const Text = node('Text');
export const Image = node('Image');
export const Shape = node('Shape');
export const Transformer = node('Transformer');
export const Arrow = node('Arrow');
