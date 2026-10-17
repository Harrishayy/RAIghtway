import Link from 'next/link';
export default function NotFound() {
  return <div className="page-pad state"><b>Nothing here</b><Link className="btn btn-secondary btn-sm" href="/review">Back to Review</Link></div>;
}
