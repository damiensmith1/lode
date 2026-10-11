export function loader({ params }: { params: { slug: string } }) {
  return params.slug;
}

export default function Post() {
  return <p>post</p>;
}
