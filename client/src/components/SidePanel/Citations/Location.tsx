import type { SGCitationLocator } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { formatJsonPath } from './path';

export default function CitationLocation({ locator }: { locator: SGCitationLocator }) {
  const localize = useLocalize();

  if (locator.kind === 'page') {
    return <>{localize('com_sg_citation_page', { page: locator.page_number })}</>;
  }
  if (locator.kind === 'slide') {
    return <>{localize('com_sg_citation_slide', { slide: locator.slide_number })}</>;
  }
  if (locator.kind === 'sheet') {
    return (
      <>
        {locator.sheet_name} ·{' '}
        {localize('com_sg_citation_cell_range', {
          startColumn: locator.start_cell.column,
          startRow: locator.start_cell.row,
          endColumn: locator.end_cell.column,
          endRow: locator.end_cell.row,
        })}
      </>
    );
  }
  if (locator.kind === 'line') {
    return (
      <>
        {localize('com_sg_citation_lines', {
          start: locator.start_line,
          end: locator.end_line,
        })}
      </>
    );
  }
  if (locator.kind === 'row') {
    return (
      <>
        {localize('com_sg_citation_rows', {
          start: locator.start_row,
          end: locator.end_row,
        })}
      </>
    );
  }
  if (locator.kind === 'structural_path') {
    return <>{locator.path_type === 'json' ? formatJsonPath(locator.path) : locator.path}</>;
  }
  if (locator.kind === 'timestamp') {
    return (
      <>
        {locator.start_ms === locator.end_ms
          ? localize('com_sg_citation_time', { time: locator.start_ms / 1000 })
          : localize('com_sg_citation_time_range', {
              start: Math.floor(locator.start_ms / 1000),
              end: Math.ceil(locator.end_ms / 1000),
            })}
        {locator.frame_number != null && (
          <> · {localize('com_sg_citation_frame', { frame: locator.frame_number })}</>
        )}
      </>
    );
  }
  return <>{localize('com_sg_citation_image')}</>;
}
