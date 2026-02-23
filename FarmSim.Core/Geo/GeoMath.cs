using System;
using System.Collections.Generic;
using System.Linq;

namespace FarmSim.Core.Geo;

/// <summary>
/// Geographic helpers for simple (but robust) map math.
/// </summary>
public static class GeoMath
{
    /// <summary>
    /// Calculates the area (in square meters) of a polygon defined by latitude/longitude vertices.
    /// The result is always positive and is suitable for small/medium polygons (e.g., farm fields).
    /// </summary>
    /// <remarks>
    /// Uses a spherical approximation (WGS84 radius) and handles clockwise/anticlockwise vertex order.
    /// </remarks>
    public static double CalculateSphericalPolygonAreaSquareMeters(IReadOnlyList<GeoPoint> vertices)
    {
        if (vertices is null) throw new ArgumentNullException(nameof(vertices));
        if (vertices.Count < 3) return 0d;

        // WGS84 equatorial radius (meters). For field-scale polygons this is sufficiently accurate.
        const double earthRadiusMeters = 6_378_137d;

        double sum = 0d;
        for (int i = 0; i < vertices.Count; i++)
        {
            GeoPoint a = vertices[i];
            GeoPoint b = vertices[(i + 1) % vertices.Count];

            double lat1 = DegToRad(a.Lat);
            double lat2 = DegToRad(b.Lat);
            double lon1 = DegToRad(a.Lng);
            double lon2 = DegToRad(b.Lng);

            double dLon = WrapRadians(lon2 - lon1);
            sum += dLon * (Math.Sin(lat1) + Math.Sin(lat2));
        }

        double area = Math.Abs(sum) * earthRadiusMeters * earthRadiusMeters / 2d;
        return area;
    }

    private static double DegToRad(double degrees) => degrees * Math.PI / 180d;

    /// <summary>
    /// Wraps an angle in radians to the [-π, +π] range.
    /// </summary>
    private static double WrapRadians(double radians)
    {
        if (radians > Math.PI) return radians - 2d * Math.PI;
        if (radians < -Math.PI) return radians + 2d * Math.PI;
        return radians;
    }
}
