namespace FarmSim.Core.Geo;

/// <summary>
/// A latitude/longitude point expressed in decimal degrees.
/// </summary>
/// <param name="Lat">Latitude in decimal degrees.</param>
/// <param name="Lng">Longitude in decimal degrees.</param>
public readonly record struct GeoPoint(double Lat, double Lng);
