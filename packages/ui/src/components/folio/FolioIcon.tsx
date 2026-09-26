import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { folioSymbols } from '@/lib/folio/icons';
export function FolioIcon({value}:{value:string}) {
 const symbol=Object.entries(folioSymbols).find(([name])=>name===value)?.[1];
 if(symbol)return <span aria-hidden="true">{symbol}</span>;
 if(value && !/^[\w.]+$/.test(value))return <span aria-hidden="true">{value}</span>;
 return <Icon name="file-text" className="size-4"/>;
}
