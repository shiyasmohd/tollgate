-- ENSv2 name of an active endpoint on Sepolia, e.g. weather.tollgate.eth (see src/ens.ts).
ALTER TABLE endpoints ADD COLUMN ens_name TEXT;
